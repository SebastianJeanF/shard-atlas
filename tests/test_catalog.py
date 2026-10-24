"""Protect the offline release reference's provenance and historical boundaries."""
import json
from pathlib import Path
import re
import unittest


class ReleaseCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'static' / 'cpp-releases.json'
        cls.catalog = json.loads(path.read_text(encoding='utf-8'))
        cls.releases = {release['id']: release for release in cls.catalog['releases']}

    def test_catalog_is_self_contained_and_sources_resolve(self):
        self.assertEqual(self.catalog['schemaVersion'], 1)
        sources = {item['id']: item for item in self.catalog['sources']}
        self.assertEqual(len(sources), len(self.catalog['sources']))
        seen = set()
        for release in self.releases.values():
            for source_id in release['sourceIds']:
                self.assertIn(source_id, sources)
            for feature in release['features']:
                self.assertNotIn(feature['id'], seen)
                seen.add(feature['id'])
                self.assertTrue(feature['title'].strip())
                self.assertTrue(feature['summary'].strip())
                self.assertTrue(feature['tags'])
                self.assertIn(feature['category'], {'language', 'library', 'change'})
                self.assertTrue(feature['sourceIds'])
                for source_id in feature['sourceIds']:
                    self.assertIn(source_id, sources)
                    self.assertTrue(sources[source_id]['url'].startswith('https://'))
                for paper in feature.get('papers', []):
                    self.assertIn('paper-' + paper.lower(), feature['sourceIds'])

    def test_release_boundaries_and_major_facilities(self):
        self.assertEqual(list(self.releases), [
            'cpp98', 'cpp03', 'cpp11', 'cpp14', 'cpp17', 'cpp20', 'cpp23', 'cpp26',
        ])
        landmarks = {
            'cpp11': 'N2118',       # Rvalue references.
            'cpp14': 'N3649',       # Generic lambdas.
            'cpp17': 'P0217R3',     # Structured bindings.
            'cpp20': 'P0734R0',     # Concepts.
            'cpp23': 'P0847R7',     # Explicit object parameters.
            'cpp26': 'P2996R13',    # Reflection.
        }
        for release_id, paper in landmarks.items():
            papers = {p for f in self.releases[release_id]['features'] for p in f.get('papers', [])}
            self.assertIn(paper, papers)
        self.assertEqual(self.releases['cpp26']['status'], 'draft')
        self.assertIn('representative', self.releases['cpp03']['summary'].lower())
        self.assertIn('not individual overloads', self.catalog['coverage'])

    def test_withdrawn_and_ts_only_facilities_are_not_presented_as_features(self):
        excluded = {'N3672', 'N3662', 'P2447R6', 'P2786R13', 'P1210R0', 'P0290R4', 'P2396R1'}
        papers = {p for r in self.releases.values() for f in r['features'] for p in f.get('papers', [])}
        self.assertFalse(papers & excluded)
        for release in self.releases.values():
            # A proposal revision may be grouped with another revision, but must
            # not create two separate library cards for the same proposal.
            seen = set()
            for feature in release['features']:
                if feature['category'] == 'language':
                    continue
                roots = {re.sub(r'R\d+$', '', p) for p in feature.get('papers', [])}
                self.assertFalse(seen & roots)
                seen.update(roots)

    def test_ambiguous_words_do_not_create_misleading_topic_tags(self):
        features = {f['title']: f for r in self.releases.values() for f in r['features']}
        self.assertNotIn('math', features['Declarations, definitions and scope']['tags'])
        self.assertNotIn('strings', features['Binary integer literals']['tags'])
        self.assertIn('ownership', features['Rvalue references and move semantics']['tags'])
        self.assertNotIn('errors', features['Make () in lambdas optional in all cases']['tags'])
        self.assertNotIn('algorithms', features['Remove undefined behavior from lexing']['tags'])


if __name__ == '__main__':
    unittest.main()
