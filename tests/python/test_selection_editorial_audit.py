import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2] / 'ops/hetzner/scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load('audit-selection-tmdb-20261002.py')
rescue = load('rescue-selection-tmdb-20261002.py')
probe = load('probe-selection-editorial-identities-20261002.py')
repair = load('repair-selection-editorial-20261002.py')


class IdentityEvidence(unittest.TestCase):
    def test_numeric_title_is_not_a_release_year(self):
        self.assertIsNone(audit.title_year('1917'))
        self.assertEqual(audit.title_year('1917 (2019)'), 2019)
        self.assertEqual(audit.title_year('Example 2024 Telugu'), 2024)

    def test_apostrophes_and_sequel_numbers(self):
        self.assertEqual(audit.normalized("Harry Potter and the Sorcerer's Stone"),
                         audit.normalized('Harry Potter and the Sorcerers Stone'))
        self.assertNotEqual(audit.normalized('Dragon 2'), audit.normalized('Dragon 3'))

    def test_homonyms_require_independent_evidence(self):
        candidates = [{'id': 1, 'title': 'A Baleia', 'release_date': '2022-01-01'},
                      {'id': 2, 'title': 'A Baleia', 'release_date': '2013-01-01'}]
        self.assertEqual(audit.unique_match('A Baleia', None, candidates), (None, 'ambiguous'))
        self.assertEqual(audit.unique_match('A Baleia', 2022, candidates)[0]['id'], 1)
        self.assertFalse(audit.exact_match('A Baleia', {'title': 'A Baleia Mágica'}))

    def test_portuguese_proof_cannot_drop_content_or_sequel(self):
        self.assertTrue(rescue.omission('Sol de Amalfi', 'Sob o Sol de Amalfi'))
        self.assertFalse(rescue.omission('A Bailarina', 'A Valsa da Bailarina'))
        self.assertFalse(rescue.omission('Dragão 2', 'O Dragão 3'))
        details = {'translations': {'translations': [{'iso_639_1': 'en', 'data': {'title': 'Sob o Sol de Amalfi'}}]}}
        self.assertFalse(rescue.extended_match('Sol de Amalfi', details, None))

    def test_filename_preserves_title_year_and_sequel(self):
        self.assertEqual(rescue.file_title('https://public.invalid/Piratas.do.Caribe_.O.Bau.da.Morte.-.BY.SANDRO.STORE.mp4'),
                         'Piratas do Caribe O Bau da Morte')
        self.assertEqual(rescue.file_title('https://public.invalid/Sol.de.Amalfi.2022.mkv'), 'Sol de Amalfi 2022')
        self.assertIsNone(rescue.file_title('https://public.invalid/proxy?url=opaque'))

    def test_duration_unknown_or_overlapping_candidates_remain_ambiguous(self):
        whale = [{'id': 1, 'runtime': 117}, {'id': 2, 'runtime': 90}]
        self.assertEqual(probe.duration_match(7011.463, whale)['id'], 1)
        self.assertIsNone(probe.duration_match(7011.463, whale + [{'id': 3, 'runtime': 0}]))
        self.assertIsNone(probe.duration_match(7011.463, whale + [{'id': 4, 'runtime': 118}]))
        self.assertIsNone(probe.duration_match(0, whale))

    def test_original_language_overview_is_not_falsely_labeled_french(self):
        row = {'item_type': 'movie', 'identity_key': 'norm:movie:example:', 'title': 'Example',
               'provider_tmdb_id': '1', 'poster_url': None, 'manifest_poster': None, 'metadata': {}}
        result = {'status': 'verified_existing', 'tmdbId': '1', 'evidence': 'existing_id_exact_alias',
                  'details': {'id': 1, 'title': 'Example', 'original_language': 'pt',
                              'translations': {'translations': [{'iso_639_1': 'pt', 'data': {'overview': 'Texto português.'}}]}}}
        change = repair.build_change(row, result)
        self.assertEqual(change['editorial']['tmdb']['overview'], 'Texto português.')
        self.assertNotIn('fr', change['editorial']['i18n'])

    def test_network_failure_cannot_quarantine_an_identity(self):
        row = {'item_type': 'movie', 'identity_key': 'norm:movie:example:', 'title': 'Example',
               'provider_tmdb_id': '1', 'poster_url': None, 'manifest_poster': None, 'metadata': {}}
        self.assertIsNone(repair.build_change(row, {'status': 'request_error', 'oldRejected': True}))


if __name__ == '__main__':
    unittest.main()
