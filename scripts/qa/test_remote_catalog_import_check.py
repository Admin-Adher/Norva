"""Offline checks: no SSH, Docker, account, provider or production requests."""
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'catalog_import', pathlib.Path(__file__).with_name('remote-catalog-import-check.py'))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class CatalogImportTests(unittest.TestCase):
    def campaign(self, fetch, **options):
        self.output, self.delays = [], []
        return CHECK.Campaign(lambda: {}, fetch=fetch, writer=self.output.append,
                              sleep=self.delays.append, **options)

    def test_epoch_retries_are_bounded_then_recover(self):
        responses = iter([(409, {'details': {'code': CHECK.EPOCH_CODE}})] * 3 + [(200, {'items': []})])
        campaign = self.campaign(lambda *args: next(responses))
        self.assertEqual(campaign.request('Lion', 'movie', 'grid', 'media-items', {}, ['items']), {'items': []})
        self.assertEqual(len(self.output[0]['attempts']), 4)
        self.assertEqual(self.delays, [.1, .3, .6])
        self.assertEqual(campaign.finish(CHECK.time.monotonic()), 0)
        self.assertEqual(self.output[-1]['retries'], 3)

    def test_exhausted_epoch_is_failure(self):
        campaign = self.campaign(lambda *args: (409, {'details': {'code': CHECK.EPOCH_CODE}}), attempts=2)
        self.assertIsNone(campaign.request('Lion', 'movie', 'grid', 'media-items', {}))
        self.assertEqual(len(self.output[0]['attempts']), 2)
        self.assertEqual(campaign.finish(CHECK.time.monotonic()), 1)

    def test_other_http_errors_never_retry(self):
        for status in (401, 403, 409, 429, 500):
            with self.subTest(status=status):
                campaign = self.campaign(lambda *args: (status, {'details': {'code': 'OTHER'}}))
                self.assertIsNone(campaign.request('Lion', 'movie', 'grid', 'media-items', {}))
                self.assertEqual(len(self.output[0]['attempts']), 1)
                self.assertEqual(self.delays, [])

    def test_network_errors_do_not_leak_or_retry(self):
        def failed(*args):
            raise OSError('secret token account-id https://user:password@provider.invalid')
        campaign = self.campaign(failed)
        campaign.request('Lion', 'movie', 'grid', 'media-items', {})
        report = json.dumps(self.output)
        for secret in ('secret', 'token', 'account-id', 'password', 'provider.invalid'):
            self.assertNotIn(secret, report)
        self.assertEqual(len(self.output[0]['attempts']), 1)

    def test_invalid_success_shape_and_missing_advertised_items_fail(self):
        for data in ({'items': 'invalid'}, {'items': []}):
            campaign = self.campaign(lambda *args: (200, data))
            self.assertIsNone(campaign.request('Lion', 'movie', 'audio', 'media-genre-items', {},
                                                expected=['items'], require_items=True))
            self.assertEqual(self.output[-1]['result'], 'fail')

    def test_dynamic_facets_categories_and_films_pagination(self):
        calls = []

        def fetch(endpoint, params, *args):
            calls.append((endpoint, params))
            if endpoint == 'media-language-facets':
                return 200, {'audio': [{'value': 'catalog-en', 'count': 80}, {'value': 'catalog-fr', 'count': 10}],
                             'subtitles': [{'value': 'catalog-ko', 'count': 41}]}
            if endpoint == 'media-genre-summary':
                return 200, {'genres': [{'bucket': 'drame', 'count': 80}, {'bucket': 'action', 'count': 12}]}
            if endpoint == 'media-items':
                return 200, {'items': [{'id': 'DO-NOT-PRINT', 'url': 'PRIVATE-URL'}],
                             'films': 2, 'hasMore': params['offset'] == 0}
            return 200, {'items': [{'id': 'DO-NOT-PRINT'}], 'count': 41, 'hasMore': params['offset'] == 0}

        campaign = self.campaign(fetch)
        campaign.run_scope('Lion', 'private-source-id', 'series')
        grid_offsets = [p['offset'] for e, p in calls if e == 'media-items']
        self.assertEqual(grid_offsets, [0, 2])
        self.assertTrue(any(p.get('audio') == 'catalog-en' for _, p in calls))
        self.assertTrue(any(p.get('subs') == 'catalog-ko' for _, p in calls))
        self.assertTrue(any(p.get('bucket') == 'drame' for _, p in calls))
        self.assertTrue(any(p.get('offset') == 36 for e, p in calls if e == 'media-genre-items'))
        serialized = json.dumps(self.output)
        for secret in ('DO-NOT-PRINT', 'PRIVATE-URL', 'private-source-id'):
            self.assertNotIn(secret, serialized)
        self.assertTrue(all(row['result'] == 'pass' for row in self.output))

    def test_absent_languages_skip_without_inventing_filters(self):
        def fetch(endpoint, params, *args):
            if endpoint == 'media-language-facets':
                return 200, {'audio': [{'value': 'unidentified', 'count': 50}], 'subtitles': []}
            if endpoint == 'media-genre-summary':
                return 200, {'genres': []}
            return 200, {'items': [], 'hasMore': False}
        campaign = self.campaign(fetch)
        campaign.run_scope('Lion', '', 'movie')
        self.assertEqual(sum(row['result'] == 'skip' for row in self.output), 3)
        self.assertEqual(campaign.finish(CHECK.time.monotonic()), 0)

    def test_grid_hasmore_without_progress_fails(self):
        campaign = self.campaign(lambda *args: (200, {'items': [], 'films': 0, 'hasMore': True}))
        campaign.pages('Lion', 'movie', 'grid', 'media-items', {})
        self.assertEqual(self.output[-1]['reason'], 'invalid_page_progress')

    def test_internal_owner_is_resolved_only_from_allowlist(self):
        owner = '00000000-0000-0000-0000-000000000001'
        source = '00000000-0000-0000-0000-000000000002'
        allowed = hashlib.sha256(owner.encode()).hexdigest()
        with patch.object(CHECK, 'container_env', return_value={'PRIVATE_RESUME_CACHE_OWNER_HASHES': allowed}), \
             patch.object(CHECK, 'sql', side_effect=[[{'user_id': owner}], [{'id': source, 'display_name': 'Lion'}]]) as db:
            actual_owner, sources = CHECK.resolve_sources('lion')
        self.assertEqual(actual_owner, owner)
        self.assertEqual(sources[0]['display_name'], 'Lion')
        self.assertIn(allowed, db.call_args_list[0].args[0])
        with patch.object(CHECK, 'container_env', return_value={'PRIVATE_RESUME_CACHE_OWNER_HASHES': 'bad'}), \
             patch.object(CHECK, 'sql') as db:
            with self.assertRaisesRegex(CHECK.CheckError, 'pilot_allowlist_invalid'):
                CHECK.resolve_sources()
            db.assert_not_called()

    def test_ambiguous_internal_lion_fails_closed(self):
        with patch.object(CHECK, 'container_env', return_value={'PRIVATE_RESUME_CACHE_OWNER_HASHES': '0' * 64}), \
             patch.object(CHECK, 'sql', return_value=[{}, {}]):
            with self.assertRaisesRegex(CHECK.CheckError, 'internal_lion_scope_ambiguous'):
                CHECK.resolve_sources()

    def test_options_decoded_without_shell_interpolation(self):
        name = "New supplier ' $(do-not-run)"
        encoded = base64.b64encode(json.dumps({'provider': name, 'attempts': 2}).encode()).decode()
        self.assertEqual(CHECK.parse_args(['--options-base64', encoded]).provider, name)
        invalid = base64.b64encode(b'{"attempts": 200}').decode()
        with self.assertRaises(CHECK.CheckError):
            CHECK.parse_args(['--options-base64', invalid])

    def test_untrusted_source_labels_are_not_printed(self):
        for name in ('user@example.com', 'https://user:pass@provider.invalid',
                     '00000000-0000-0000-0000-000000000001'):
            self.assertEqual(CHECK.source_label({'display_name': name}, 2), 'Provider 2')
        self.assertEqual(CHECK.source_label({'display_name': 'Lion'}, 2), 'Lion')

    def test_main_setup_failure_is_sanitized_and_nonzero(self):
        out = []
        with patch.object(CHECK, 'resolve_sources', side_effect=RuntimeError('PRIVATE-ACCOUNT')), \
             patch.object(CHECK, 'emit', side_effect=out.append):
            self.assertEqual(CHECK.main([]), 2)
        self.assertEqual(out[0]['result'], 'fail')
        self.assertNotIn('PRIVATE-ACCOUNT', json.dumps(out))

    def test_http_transport_uses_get_and_refreshes_auth(self):
        class Response(io.BytesIO):
            code = 200
        seen = []
        def opener(request, timeout):
            seen.append(request)
            return Response(b'{"items": []}')
        with patch.object(CHECK.urllib.request, 'urlopen', side_effect=opener):
            result = CHECK.get_payload('media-items', {'type': 'movie'}, lambda: {'Authorization': 'Bearer private'}, 30)
        self.assertEqual(result, (200, {'items': []}))
        self.assertEqual(seen[0].method, 'GET')
        self.assertTrue(seen[0].full_url.startswith(CHECK.BASE_URL))


if __name__ == '__main__':
    unittest.main()
