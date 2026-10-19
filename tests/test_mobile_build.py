"""Verify the phone shell never ships personal state or changes desktop assets."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mobile_build', ROOT / 'tools/build_mobile.py')
mobile_build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mobile_build)


class MobileBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.output = self.directory / 'phone'

    def test_public_shell_preserves_desktop_and_precaches_all_assets(self):
        original_index = (ROOT / 'static/index.html').read_bytes()
        original_app = (ROOT / 'static/app.js').read_bytes()
        result = mobile_build.build(self.output)
        shell = (self.output / 'index.html').read_text()
        script = (self.output / 'app.js').read_text()
        self.assertIn('src="/bootstrap.mjs"', shell)
        self.assertNotIn('src="/app.js"', shell)
        self.assertIn('viewport-fit=cover', shell)
        self.assertIn('rel="manifest"', shell)
        self.assertIn('rel="apple-touch-icon"', shell)
        self.assertIn('href="/phone.css"', shell)
        self.assertIn('(window.shardAtlasMobile?.fetch || fetch)(path,', script)
        self.assertIn('window.shardAtlasMobile?.imageSource(image)', script)
        self.assertIn('window.shardAtlasMobile?.imageSource(src)', script)
        self.assertNotIn('this Mac', script)
        self.assertEqual((ROOT / 'static/index.html').read_bytes(), original_index)
        self.assertEqual((ROOT / 'static/app.js').read_bytes(), original_app)
        worker = (self.output / 'sw.js').read_text()
        precache = json.loads(re.search(r'const PRECACHE_FILES = (.*);', worker).group(1))
        self.assertIn(result['version'], worker)
        self.assertNotIn('__SHARD_ATLAS_', worker)
        self.assertIn('/index.html', precache)
        self.assertIn('/vendor/katex/katex.min.js', precache)
        self.assertTrue(any(path.startswith('/vendor/katex/fonts/') for path in precache))
        self.assertIn('/spiral/cpp98.svg', precache)
        self.assertIn('/cpp-releases.json', precache)
        self.assertNotIn('/sw.js', precache)
        self.assertNotIn('/seed.json', precache)
        self.assertFalse(any(path.startswith(('/api', '/assets')) for path in precache))
        for path in precache:
            if path != '/':
                self.assertTrue((self.output / path.lstrip('/')).is_file(), path)
        for path in self.output.rglob('*'):
            if path.is_file() and path.name != 'sw.js':
                self.assertIn('/' + path.relative_to(self.output).as_posix(), precache)

    def test_repeatable_build_replaces_stale_output(self):
        first = mobile_build.build(self.output)
        first_worker = (self.output / 'sw.js').read_bytes()
        (self.output / 'stale-private-export.json').write_text('not a shipped asset')
        second = mobile_build.build(self.output)
        self.assertEqual(first['version'], second['version'])
        self.assertEqual((self.output / 'sw.js').read_bytes(), first_worker)
        self.assertFalse((self.output / 'stale-private-export.json').exists())

    def test_changed_shell_gets_a_new_offline_cache(self):
        checkout = self.directory / 'checkout'
        shutil.copytree(ROOT / 'static', checkout / 'static')
        shutil.copytree(ROOT / 'mobile', checkout / 'mobile')
        with patch.object(mobile_build, 'ROOT', checkout):
            first = mobile_build.build(self.output)
            (checkout / 'static/styles.css').write_text('/* a new release */')
            second = mobile_build.build(self.output)
        self.assertNotEqual(first['version'], second['version'])

    def test_incomplete_build_keeps_previous_output(self):
        checkout = self.directory / 'checkout'
        shutil.copytree(ROOT / 'mobile', checkout / 'mobile')
        (checkout / 'mobile/bootstrap.mjs').unlink()
        self.output.mkdir()
        (self.output / 'previous.txt').write_text('previous release')
        with patch.object(mobile_build, 'ROOT', checkout), self.assertRaisesRegex(ValueError, 'bootstrap.mjs'):
            mobile_build.build(self.output)
        self.assertEqual((self.output / 'previous.txt').read_text(), 'previous release')

    def test_install_metadata_uses_existing_brand_and_expected_sizes(self):
        manifest = json.loads((ROOT / 'mobile/manifest.webmanifest').read_text())
        self.assertEqual(manifest['name'], 'Shard Atlas')
        self.assertEqual(manifest['start_url'], './')
        self.assertEqual(manifest['scope'], './')
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['theme_color'], '#315645')
        self.assertEqual(manifest['background_color'], '#f6f5f0')
        for filename, size in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
            data = (ROOT / 'mobile/icons' / filename).read_bytes()
            self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
            self.assertEqual(struct.unpack('>II', data[16:24]), (size, size))

    def test_output_and_symlink_guards_protect_source_and_private_files(self):
        for unsafe in (ROOT, ROOT.parent, ROOT / 'static' / 'phone', ROOT / 'mobile'):
            with self.subTest(path=unsafe), self.assertRaises(ValueError):
                mobile_build._validate_output(unsafe)
        private = self.directory / 'private.txt'
        private.write_text('private note')
        source = self.directory / 'source'
        source.mkdir()
        (source / 'leak.txt').symlink_to(private)
        with self.assertRaises(ValueError):
            mobile_build._copy_public_tree(source, self.output)
        self.assertFalse((self.output / 'leak.txt').exists())
        alias = self.directory / 'alias'
        alias.symlink_to(source, target_is_directory=True)
        with self.assertRaises(ValueError):
            mobile_build._copy_public_tree(alias, self.output)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for service worker routing checks')
    def test_worker_ignores_private_requests_and_loads_cached_shell_offline(self):
        mobile_build.build(self.output)
        harness = r'''
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const events = {};
const shell = new Response('cached shell', {headers:{'content-type':'text/html'}});
const cached = new Map([['/index.html',shell],['/styles.css',new Response('cached style')]]);
let networkCalls = 0;
const context = {
  self: {location:{origin:'https://atlas.example'}, clients:{claim:async()=>{}},
    addEventListener:(name,handler)=>{events[name]=handler;}},
  caches:{open:async()=>({match:async path=>cached.get(path)?.clone(), put:async(path,response)=>cached.set(path,response)}),
    keys:async()=>[],delete:async()=>{}},
  fetch:async()=>{networkCalls++;throw new Error('offline');},
  Request, Response, URL, Set, Promise,
};
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),context);
const request=(path,extra={})=>({url:'https://atlas.example'+path,method:'GET',mode:'cors',...extra});
const run=request=>{let response;events.fetch({request,respondWith:promise=>response=promise});return response;};
(async()=>{
  for(const path of ['/api/state','/api','/assets/private-image','/assets']) {
    assert.equal(run(request(path)),undefined);
    assert.equal(run(request(path,{mode:'navigate'})),undefined);
  }
  assert.equal(run(request('/styles.css',{method:'POST'})),undefined);
  assert.equal(run(request('/unknown.json')),undefined);
  assert.equal(run(request('/styles.css?secret=private')),undefined);
  assert.equal(run({url:'https://other.example/styles.css',method:'GET',mode:'cors'}),undefined);
  assert.equal(await (await run(request('/styles.css'))).text(),'cached style');
  assert.equal(networkCalls,0);
  assert.equal(await (await run(request('/',{mode:'navigate'}))).text(),'cached shell');
  assert.equal(networkCalls,0);
  assert.equal(await (await run(request('/index.html',{mode:'navigate'}))).clone().text(),'cached shell');
  assert.equal(networkCalls,0);
  assert.equal(await (await run(request('/unknown-route',{mode:'navigate'}))).clone().text(),'cached shell');
  assert.equal(networkCalls,1);
})().catch(error=>{console.error(error);process.exit(1);});
'''
        subprocess.run(['node', '-e', harness, str(self.output / 'sw.js')], check=True, capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main()
