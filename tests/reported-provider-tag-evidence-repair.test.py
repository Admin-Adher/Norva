import copy
import importlib.util
import pathlib
import sys
import types
import unittest

try:
    import fcntl
except ModuleNotFoundError:
    sys.modules['fcntl'] = types.SimpleNamespace()

PATH = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/repair-reported-provider-tags-20260913.py'
spec = importlib.util.spec_from_file_location('reported_provider_tag_repair', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReportedProviderTagRepairTest(unittest.TestCase):
    def test_unbound_legacy_track_is_eligible_regardless_of_iso_language(self):
        for language in ('rn', 'ch', 'hz', 'na', 'fr', 'en'):
            value = {'tracks': [{'index': 1, 'lang': language}]}
            before = copy.deepcopy(value)
            self.assertTrue(module.safe_legacy(value))
            self.assertEqual(value, before)

    def test_verified_bound_or_scheduled_files_are_never_overwritten(self):
        for key in ('verified', 'job', 'retryAt', 'probeCircuitRetryAt',
                    'observedFingerprint', 'observedAt', 'observedProfile'):
            with self.subTest(key=key):
                self.assertFalse(module.safe_legacy({
                    'tracks': [{'index': 1, 'lang': 'rn'}], key: 'protected',
                }))
        for state in ('queued', 'running', 'completed', 'failed', 'quarantined'):
            self.assertFalse(module.safe_legacy({
                'tracks': [{'index': 1, 'lang': 'rn'}], 'job': {'status': state},
            }))

    def test_absent_file_or_empty_map_cannot_be_repaired(self):
        for value in (None, False, [], {}, {'tracks': []}, {'tracks': None}):
            self.assertFalse(module.safe_legacy(value))

    def test_scope_is_six_exact_owned_movie_files_not_a_language_blacklist(self):
        source = PATH.read_text(encoding='utf-8')
        for text in ('len(rows) == 6', "v.item_type='movie'", 'internal.user_id=v.user_id',
                     'i.source_id=v.source_id AND i.user_id=v.user_id',
                     'c.external_id=v.external_id', 'c.audio_lang_verified_at IS NULL',
                     'c.observed_profile_fingerprint IS NULL',
                     "value['tracks'] == row['original_tracks']"):
            self.assertIn(text, source)

    def test_only_normal_guarded_header_route_is_called_without_cancelling_other_jobs(self):
        source = PATH.read_text(encoding='utf-8')
        self.assertEqual(source.count('pilot.header_probe(row)'), 1)
        self.assertIn('require(pilot.controls()', source)
        self.assertIn("require(not (after or {}).get('job')", source)
        for forbidden in ('assert_idle(', 'enqueue(', 'kill(', 'SIGTERM', 'forceProbe',
                          'UPDATE public.', 'DELETE FROM', 'unlink(', 'remove('):
            self.assertNotIn(forbidden, source)

    def test_immutable_receipts_and_expiry_prevent_a_blind_retry(self):
        source = PATH.read_text(encoding='utf-8')
        for text in ("time.time() < plan['expiresAt']", "plan['operatorSha256']",
                     "'prior_intent_protected'", "'uncertain_call_protected'",
                     "save('-before'", "save('-after'", "save('-uncertain'"):
            self.assertIn(text, source)
        self.assertLess(source.index("save('-intent'"), source.index('pilot.header_probe(row)'))


if __name__ == '__main__':
    unittest.main()
