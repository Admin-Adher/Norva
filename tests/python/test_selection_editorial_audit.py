import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

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
deep = load('audit-selection-deeper-search-20261002.py')
units = load('prove-selection-source-units-20261002.py')
duration = load('prove-selection-media-duration-20261002.py')
exhaustive = load('audit-selection-exhaustive-20261002.py')
qualified = load('prove-selection-exhaustive-sources-20261002.py')
full_apply = load('apply-selection-exhaustive-20261002.py')


class IdentityEvidence(unittest.TestCase):
    def test_old_poster_cannot_survive_a_different_identity_without_source_proof(self):
        class Api:
            def get(self, *args, **kwargs):
                return {'posters': []}
        row = {'item_type': 'movie', 'provider_tmdb_id': '1', 'poster_url': 'https://image.tmdb.org/t/p/w500/old.jpg'}
        result = {'tmdbId': '2', 'details': {'id': 2}}
        with patch.object(full_apply, 'good_artwork', return_value=True):
            self.assertIsNone(full_apply.candidate_poster(Api(), row, result))

    def test_tmdb_throttle_backs_off_all_workers(self):
        import tempfile
        import threading
        import urllib.error
        import io
        api = audit.Tmdb.__new__(audit.Tmdb)
        api.key = 'unit-test-key'; api.lock = threading.Lock(); api.next_request = 0
        api.requests = 0; api.request_interval = 1 / 24
        error = urllib.error.HTTPError('https://api.themoviedb.org/unit', 429, 'rate limited', {'Retry-After': '2'}, None)
        with tempfile.TemporaryDirectory() as temp:
            api.cache = Path(temp)
            with patch.object(audit.urllib.request, 'urlopen', side_effect=[error, io.BytesIO(b'{"id":1}')]), \
              patch.object(audit.time, 'sleep'), patch.object(audit.time, 'monotonic', return_value=100):
                self.assertEqual(api.get('movie/1'), {'id': 1})
        self.assertGreaterEqual(api.request_interval, 0.125)
        self.assertEqual(api.requests, 2)

    def test_exhaustive_source_conflict_cannot_be_hidden_by_exact_name(self):
        row = {'item_type': 'movie', 'title': 'A Complete Example', 'provider_units': [
          {'title': 'A Complete Example', 'provider_year': 2023, 'provider_group': 'Movies / Telugu / 1990'}]}
        d = {'id': 1, 'title': 'A Complete Example', 'release_date': '2023-01-01'}
        self.assertIsNone(exhaustive.independent_assessment(row, [d], [('provider_title', row['title'])], False)[0])

    def test_exhaustive_truncated_homonym_set_cannot_certify_identity(self):
        row = {'item_type': 'movie', 'title': 'A Complete Example', 'provider_units': []}
        d = {'id': 1, 'title': 'A Complete Example'}
        self.assertEqual(exhaustive.independent_assessment(row, [d], [('provider_title', row['title'])], True)[1], 'truncated_candidates')

    def test_qualified_duration_requires_exact_url_sampling_receipt(self):
        import hashlib
        url = 'https://public.invalid/example.mp4'
        media = {'external_id': 'sample', 'playback_hint': {'targetUrl': url}, 'metadata': {'duration': 6000,
          'selectionPlaybackValidation': {'urlSha256': hashlib.sha256(url.encode()).hexdigest(),
            'method': 'server-sampling-and-file-access', 'fileHttpStatus': 206,
            'sourceCommit': 'abc', 'containerMetadataCheckedAt': '2026-09-07'}}}
        self.assertEqual(qualified.qualified_duration(media)['seconds'], 6000)
        media['playback_hint']['targetUrl'] = 'https://public.invalid/another.mp4'
        self.assertIsNone(qualified.qualified_duration(media))

    def test_mixed_qualified_versions_remain_unresolved(self):
        import hashlib
        def media(seconds, name):
            url = 'https://public.invalid/' + name + '.mp4'
            return {'external_id': name, 'playback_hint': {'targetUrl': url}, 'metadata': {'duration': seconds,
              'selectionPlaybackValidation': {'urlSha256': hashlib.sha256(url.encode()).hexdigest(),
                'method': 'server-sampling-and-file-access', 'fileHttpStatus': 206,
                'sourceCommit': 'abc', 'containerMetadataCheckedAt': '2026-09-07'}}}
        row = {'item_type': 'movie', 'title': 'Example'}
        ds = [{'id': 1, 'title': 'Example', 'runtime': 100}, {'id': 2, 'title': 'Example', 'runtime': 80}]
        hit, reason, proof = qualified.durations_identity(row, ds, [media(6000, 'first'), media(4800, 'second')])
        self.assertIsNone(hit); self.assertEqual(reason, 'ambiguous_source_versions'); self.assertEqual(len(proof), 2)

    def test_image_transport_failure_is_unknown_not_missing(self):
        with patch.object(exhaustive.urllib.request, 'urlopen', side_effect=TimeoutError()):
            result = exhaustive.check_artwork('https://public.invalid/poster.jpg')
        self.assertEqual(result['status'], 'request_error')

    def test_wider_search_does_not_stop_on_first_locale_empty_stub(self):
        class Api(deep.WiderTmdb):
            def __init__(self):
                self.locales = []
            def get(self, endpoint, **params):
                self.locales.append(params['language'])
                data = [{'id': 1, 'name': 'Special Ops'}]
                if params['language'] == 'en-US':
                    data.append({'id': 2, 'name': 'Special Ops', 'first_air_date': '2020-03-17'})
                return {'results': data, 'total_pages': 1}
            def details(self, kind, ident):
                return {'id': ident, 'name': 'Special Ops'}
        api = Api()
        found, cap = api.search('series', 'Special Ops', None)
        self.assertEqual({d['id'] for d in found}, {1, 2})
        self.assertIn('fr-FR', api.locales)
        self.assertFalse(cap)

    def test_hls_duration_requires_endlist_and_never_downloads_segments(self):
        class Response:
            url = 'https://public.invalid/movie.m3u8'
            def __init__(self, value):
                self.value = value
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, size):
                return self.value
        terminal = b'#EXTM3U\n#EXTINF:6.5,\n1.ts\n#EXTINF:7.0,\n2.ts\n#EXT-X-ENDLIST\n'
        with patch.object(duration.urllib.request, 'urlopen', return_value=Response(terminal)) as opened:
            self.assertEqual(duration.playlist_duration(Response.url), 13.5)
            self.assertEqual(opened.call_count, 1)
        with patch.object(duration.urllib.request, 'urlopen', return_value=Response(terminal.replace(b'#EXT-X-ENDLIST', b''))):
            with self.assertRaises(ValueError):
                duration.playlist_duration(Response.url)

    def test_candidate_discovery_does_not_supply_identity_confidence(self):
        d = {'id': 1, 'title': 'As Aventuras de Tintim', 'release_date': '2011-01-01'}
        self.assertGreater(deep.discovery_score('As Aventuras de TimTim', d), 0.9)
        self.assertIsNone(remainder.assess({'title': 'As Aventuras de TimTim'}, [d],
          [('provider_title', 'As Aventuras de TimTim')])[0])

    def test_compact_alias_requires_raw_year_and_matching_feed_group(self):
        row = {'item_type': 'movie', 'title': '192021', 'provider_units': [
          {'title': '192021 Telugu', 'provider_year': 2023, 'provider_group': 'Movies / Telugu / 2023'}]}
        d = {'id': 1, 'title': '19.20.21', 'release_date': '2023-03-03'}
        self.assertEqual(units.assess(row, [d])[0][0]['id'], 1)
        row['provider_units'][0]['provider_group'] = 'Movies / Telugu / 1990'
        self.assertEqual(units.assess(row, [d])[1], 'conflicting_or_unverified_provider_year')

    def test_series_later_season_uses_its_date_and_does_not_select_empty_stub(self):
        row = {'item_type': 'series', 'title': 'Special Ops', 'provider_units': [
          {'title': 'Special Ops Season 2', 'provider_year': 2025, 'provider_group': 'Movies / Telugu / 2025',
           'source_unit': {'baseTitle': 'Special Ops', 'seasons': [2]}}]}
        d = {'id': 1, 'name': 'Special OPS', 'first_air_date': '2020-03-17',
             'seasons': [{'season_number': 1, 'air_date': '2020-03-17'}, {'season_number': 2, 'air_date': '2025-07-18'}]}
        stub = {'id': 2, 'name': 'Special Ops', 'seasons': []}
        self.assertEqual(units.assess(row, [d, stub])[0][0]['id'], 1)
        d['seasons'][1]['air_date'] = '2022-01-01'
        self.assertIsNone(units.assess(row, [d, stub])[0])

    def test_source_units_cannot_override_conflicting_other_variant(self):
        row = {'item_type': 'movie', 'title': 'Antony', 'provider_units': [
          {'title': 'Antony', 'provider_year': 2023, 'provider_group': 'Movies / Telugu / 2023'},
          {'title': 'Antony', 'provider_year': 2018, 'provider_group': 'Movies / Telugu / 2018'}]}
        self.assertIsNone(units.assess(row, [{'id': 1, 'title': 'Antony', 'release_date': '2023-12-01'}])[0])

    def test_source_season_conflict_and_homonyms_remain_ambiguous(self):
        row = {'item_type': 'series', 'title': 'Example', 'provider_units': [
          {'title': 'Example Season 1', 'provider_year': 2023, 'provider_group': 'Movies / Hindi / 2023',
           'source_unit': {'baseTitle': 'Example', 'seasons': [1]}}]}
        ds = [{'id': n, 'name': 'Example', 'seasons': [{'season_number': 1, 'air_date': '2023-01-01'}]} for n in [1, 2]]
        self.assertEqual(units.assess(row, ds)[1], 'ambiguous_source_units')
        row['provider_units'][0]['source_unit']['baseTitle'] = 'Another Example'
        self.assertEqual(units.assess(row, ds)[1], 'source_unit_title_conflict')

    def test_duration_typo_discovery_preserves_sequel_markers(self):
        self.assertEqual(duration.duration_alias('As Aventuras de TimTim', {'title': 'As Aventuras de Tintim'}), 'single_character_typo')
        self.assertIsNone(duration.duration_alias('Harry Potter 2 Example', {'title': 'Harry Potter 3 Example'}))
        self.assertIsNone(duration.duration_alias('Very Long Example II', {'title': 'Very Long Example III'}))
        self.assertIsNone(duration.duration_alias('Very Long Example Title', {'title': 'Very Long Example Title II'}))
        self.assertIsNone(duration.duration_alias('A Bala', {'title': 'A Bola'}))
        self.assertIsNone(duration.duration_alias('Very Long Inaccurate Title', {'title': 'Very Long Different Title'}))

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
