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
remainder = load('audit-selection-remainder-20261002.py')


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

    def test_source_image_label_retains_numbers_and_ignores_opaque_tmdb_paths(self):
        self.assertEqual(remainder.image_label('https://provider.invalid/11-11-Telugu.jpg'), '11 11 Telugu')
        self.assertEqual(remainder.image_label('https://provider.invalid/Film-2-Tamil-Poster.jpg'), 'Film 2 Tamil')
        self.assertIsNone(remainder.image_label('https://image.tmdb.org/t/p/w500/opaque.jpg'))
        self.assertIsNone(remainder.image_label('https://provider.invalid/poster.jpg'))

    def test_image_label_confirms_only_compatible_long_truncated_provider_title(self):
        row = {'title': 'Arimapatti Sakthive'}
        d = {'id': 1, 'title': 'Arimapatti Sakthivel', 'release_date': '2024-01-01'}
        hit, reason, _ = remainder.assess(row, [d], [('provider_title', row['title']),
                                                     ('image_filename', 'Arimapatti Sakthivel Tamil')])
        self.assertEqual(hit[0], '1')
        self.assertEqual(hit[1], 'source_image_filename_exact_alias')
        self.assertIsNone(reason)
        hit, reason, _ = remainder.assess({'title': 'Another Long Film'}, [d],
          [('provider_title', 'Another Long Film'), ('image_filename', 'Arimapatti Sakthivel Tamil')])
        self.assertIsNone(hit)
        self.assertEqual(reason, 'image_title_conflict')

    def test_source_year_conflict_and_numeric_names_remain_unresolved(self):
        d = {'id': 1, 'title': '192021', 'release_date': '2023-01-01'}
        self.assertEqual(remainder.assess({'title': '192021'}, [d], [('provider_title', '192021')])[1],
                         'needs_independent_media_identity')
        self.assertEqual(remainder.assess({'title': 'Example'}, [],
          [('provider_title', 'Example 2023'), ('media_filename', 'Example 1990')])[1], 'conflicting_source_years')

    def test_official_fallback_keeps_its_language_and_never_creates_french_translation(self):
        d = {'translations': {'translations': [{'iso_639_1': 'ar', 'data': {'overview': 'نص رسمي'}}]}}
        self.assertEqual(remainder.synopsis(d), ('ar', 'نص رسمي'))
        self.assertEqual(remainder.synopsis({}), (None, None))

    def test_complete_filename_does_not_choose_a_generic_title_homonym(self):
        candidates = [{'id': 1, 'title': 'A Bela Adormecida'},
          {'id': 2, 'title': 'Dragon Ball A Bela Adormecida no Castelo do Diabo'}]
        hints = [('provider_title', 'A Bela Adormecida'),
          ('media_filename', 'Dragon Ball A Bela Adormecida no Castelo do Diabo')]
        hit, reason, _ = remainder.assess({'title': 'A Bela Adormecida'}, candidates, hints)
        self.assertEqual(hit[0], '2')
        self.assertEqual(hit[1], 'unique_source_filename_alias')
        hints.append(('media_filename', 'Other Franchise A Bela Adormecida'))
        self.assertIsNone(remainder.assess({'title': 'A Bela Adormecida'}, candidates, hints)[0])

    def test_subtitle_prefix_does_not_drop_a_sequel_number(self):
        self.assertTrue(remainder.prefix_alias('A Hora do Pesadelo 2', {'title': 'A Hora do Pesadelo 2 A Vingança'}))
        self.assertFalse(remainder.prefix_alias('A Hora do Pesadelo', {'title': 'A Hora do Pesadelo 2 A Vingança'}))
        self.assertFalse(remainder.prefix_alias('A Hora do Pesadelo 3', {'title': 'A Hora do Pesadelo 2 A Vingança'}))
        self.assertFalse(remainder.prefix_alias('Demolidor', {'title': 'Demolidor O Homem Sem Medo'}))


if __name__ == '__main__':
    unittest.main()
