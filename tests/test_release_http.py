"""Real loopback coverage for release routes without personal data or cloud writes."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import LocalServer, Store
from release_status import ReleaseUnavailable


class ReleaseHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = Store(root / 'qa.sqlite3', root=root, seed=False, backup_on_start=False, automatic_backups=False)
        self.release_patch = patch('release_status.ReleaseStatus')
        self.release = self.release_patch.start().return_value
        self.server = LocalServer(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.release_patch.stop()
        self.temporary.cleanup()

    def request(self, path, method='GET'):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, path)
        response = connection.getresponse()
        data = response.read()
        headers = dict(response.getheaders())
        connection.close()
        return response.status, headers, data

    def test_aliases_return_only_checked_published_identity_and_private_no_cache_headers(self):
        value = {'application': 'shard-atlas', 'releaseId': 'a' * 64}
        self.release.published_manifest.return_value = value
        for path in ('/api/release', '/api/sync/release'):
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Cache-Control'], 'no-store, private')
            self.assertEqual(headers['X-Shard-Atlas-Sync'], '1')
            self.assertEqual(json.loads(body), value)
        self.assertEqual(self.request('/api/release', 'HEAD')[2], b'')

    def test_unavailable_reference_never_falls_back_to_local_as_published(self):
        self.release.published_manifest.side_effect = ReleaseUnavailable('offline', 'Reconnect and retry.')
        status, headers, body = self.request('/api/release')
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)['code'], 'offline')
        self.assertEqual(headers['Cache-Control'], 'no-store, private')

    def test_loaded_interface_and_compiled_native_identity_reach_classifier(self):
        self.release.status.return_value = {'state': 'native_update_required', 'publishedAvailable': True}
        status, headers, body = self.request('/api/release-status?frontendId=front&nativeId=compiled')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['state'], 'native_update_required')
        self.release.status.assert_called_once_with(frontend_id='front', native_id='compiled')
        self.assertEqual(headers['Cache-Control'], 'no-store, private')
        self.assertEqual(self.request('/api/release-status?nativeId=a&nativeId=b')[0], 400)


if __name__ == '__main__':
    unittest.main()
