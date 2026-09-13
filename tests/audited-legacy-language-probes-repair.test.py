import copy
import importlib.util
import io
import pathlib
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

try:
    import fcntl
except ModuleNotFoundError:
    sys.modules['fcntl'] = types.SimpleNamespace()

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = ROOT / 'ops/hetzner/scripts/repair-audited-legacy-language-probes-20260913.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


module = load('audited_legacy_repair', PATH)
legacy = load('audited_legacy_pure_helper', ROOT / 'ops/hetzner/scripts/repair-reported-provider-tags-20260913.py')


def candidate(sample=1):
    target = module.TARGETS[sample - 1]
    return {**{key: target[key] for key in ('variant_id', 'external_id', 'title', 'raw_title', 'category')},
            'user_id': module.USER_ID, 'source_id': module.SOURCE_ID,
            'identity_key': '11111111-1111-1111-1111-111111111111',
            'original_tracks': [{'index': 1, 'lang': target['old_language']}],
            'original_probed_at': '2026-07-01T00:00:00Z', 'identity_verified': True,
            'before_audit': True, 'cache_digest': 'a' * 32, 'variant_digest': 'b' * 32,
            'verification': {}, 'whisper_verification': {}}


class PureEligibilityTest(unittest.TestCase):
    def test_only_the_two_exact_audited_rows_are_eligible(self):
        for sample in (1, 2):
            row = candidate(sample)
            value = {'tracks': row['original_tracks']}
            self.assertTrue(module.eligible(row, value, module.TARGETS[sample - 1], legacy.safe_legacy))
            for field in ('variant_id', 'external_id', 'title', 'raw_title', 'category', 'user_id', 'source_id'):
                altered = {**row, field: 'another-row'}
                self.assertFalse(module.eligible(altered, value, module.TARGETS[sample - 1], legacy.safe_legacy), field)

    def test_bound_kik_verified_jobs_retries_and_new_provenance_are_protected(self):
        row = candidate()
        for field in ('verified', 'job', 'retryAt', 'probeCircuitRetryAt', 'observedFingerprint', 'observedAt', 'observedProfile'):
            value = {'tracks': row['original_tracks'], field: 'protected'}
            self.assertFalse(module.eligible(row, value, module.TARGETS[0], legacy.safe_legacy), field)
        for state in ('queued', 'running', 'completed', 'failed', 'quarantined'):
            self.assertFalse(module.eligible(row, {'tracks': row['original_tracks'], 'job': {'state': state}},
                                             module.TARGETS[0], legacy.safe_legacy))
        for delta in ({'before_audit': False}, {'identity_verified': False},
                      {'verification': {'status': 'observed'}}, {'whisper_verification': {'status': 'queued'}},
                      {'original_tracks': [{'index': 1, 'lang': 'kik'}]}):
            self.assertFalse(module.eligible({**row, **delta}, {'tracks': row['original_tracks']},
                                             module.TARGETS[0], legacy.safe_legacy))

    def test_target_queries_are_read_only_and_pinned_to_owner_source_variant_and_file(self):
        queries = []
        pilot = types.SimpleNamespace(lib=types.SimpleNamespace(literal=lambda value: "'" + value + "'"),
                                      query=lambda query: queries.append(query))
        module.read_target(pilot, 1)
        module.read_target(pilot, 2)
        for sample, query in enumerate(queries):
            for value in (module.USER_ID, module.SOURCE_ID, module.TARGETS[sample]['variant_id'],
                          module.TARGETS[sample]['external_id'], "v.item_type='movie'", 'i.source_id=v.source_id AND i.user_id=v.user_id'):
                self.assertIn(value, query)
            for verb in ('UPDATE ', 'DELETE ', 'INSERT ', 'COMMIT'):
                self.assertNotIn(verb, query)


class OperatorWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.patches = []
        for name, value in (
            ('ROOT', pathlib.Path(self.directory.name)),
            ('runtime_fingerprint', lambda *_: 'runtime-v1'),
            ('code_fingerprints', lambda: {'operator': 'code-v1'}),
            ('read_target', lambda _, sample: copy.deepcopy(candidate(sample))),
        ):
            patcher = patch.object(module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.states = {target['external_id']: {'tracks': [{'index': 1, 'lang': target['old_language']}]}
                       for target in module.TARGETS}
        self.calls = []
        self.helper = types.SimpleNamespace(safe_legacy=legacy.safe_legacy)
        self.pilot = types.SimpleNamespace(current=lambda row: copy.deepcopy(self.states[row['external_id']]),
                                           profile_ready=lambda value: bool(value.get('observedFingerprint')),
                                           header_probe=self.header)
        with redirect_stdout(io.StringIO()):
            module.prepare(self.helper, None, self.pilot)
        self.sha = module.digest(module.read('plan.private.json'))

    def header(self, row):
        self.calls.append(row['external_id'])
        self.states[row['external_id']].update(observedFingerprint='f' * 64, observedAt='2026-09-13T12:00:00Z')
        return {'attempted': 1, 'persisted': 1, 'deferredBeforeIO': False, 'reason': None}

    def apply(self, sample=1, sha=None, confirmed=True):
        with redirect_stdout(io.StringIO()):
            module.apply(self.helper, None, self.pilot, sample, sha or self.sha, confirmed)

    def test_prepare_performs_no_provider_request_and_two_steps_preserve_actual_de_en(self):
        self.assertEqual(self.calls, [])
        self.apply(1)
        self.apply(2)
        self.assertEqual(self.calls, ['1069415', '1305857'])
        for sample, language in ((1, 'de'), (2, 'en')):
            receipt = module.read(f'{sample:02d}-closed.private.json')
            self.assertEqual(receipt['tracks'], [{'index': 1, 'lang': language}])
            self.assertEqual(receipt['outcome'], 'refreshed')
            self.assertEqual(receipt['speechJobsCreated'], 0)

    def test_second_sample_cannot_start_before_first_is_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'receipt_missing_or_unsafe'):
            self.apply(2)
        self.assertEqual(self.calls, [])

    def test_explicit_authority_and_exact_plan_fingerprint_are_required(self):
        for args, code in (({'confirmed': False}, 'explicit_header_confirmation_required'),
                           ({'sha': '0' * 64}, 'plan_fingerprint_mismatch')):
            with self.assertRaisesRegex(RuntimeError, code):
                self.apply(**args)
        self.assertEqual(self.calls, [])

    def test_code_runtime_and_evidence_drift_stop_before_intent(self):
        for name, value, code in (
            ('code_fingerprints', lambda: {'operator': 'changed'}, 'operator_dependency_changed'),
            ('runtime_fingerprint', lambda *_: 'changed', 'runtime_changed'),
            ('read_target', lambda _, sample: {**candidate(sample), 'cache_digest': 'changed'}, 'file_evidence_changed'),
        ):
            with patch.object(module, name, value), self.assertRaisesRegex(RuntimeError, code):
                self.apply()
        self.assertEqual(self.calls, [])
        self.assertFalse((module.ROOT / '01-intent.private.json').exists())

    def test_expired_plan_cannot_run(self):
        with patch.object(module.time, 'time', lambda: module.read('plan.private.json')['expiresAt'] + 1):
            with self.assertRaisesRegex(RuntimeError, 'plan_expired'):
                self.apply()
        self.assertEqual(self.calls, [])

    def test_immutable_intent_blocks_repeat_even_after_success(self):
        self.apply()
        with self.assertRaisesRegex(RuntimeError, 'prior_intent_protected'):
            self.apply()
        self.assertEqual(len(self.calls), 1)

    def test_uncertain_result_stops_entire_plan_without_retry(self):
        def fail(row):
            self.calls.append(row['external_id'])
            raise TimeoutError('private transport detail')
        self.pilot.header_probe = fail
        with self.assertRaisesRegex(RuntimeError, 'failed_or_uncertain_no_retry'):
            self.apply()
        self.assertTrue((module.ROOT / '01-uncertain.private.json').exists())
        for sample in (1, 2):
            with self.assertRaisesRegex(RuntimeError, 'uncertain_call_protected'):
                self.apply(sample)
        self.assertEqual(len(self.calls), 1)

    def test_zero_io_deferral_is_recorded_but_never_automatically_retried(self):
        self.pilot.header_probe = lambda _: {'attempted': 0, 'persisted': 0, 'deferredBeforeIO': True,
                                           'reason': 'provider-account-busy'}
        self.apply()
        self.assertEqual(module.read('01-closed.private.json')['outcome'], 'deferred_no_retry')
        with self.assertRaisesRegex(RuntimeError, 'prior_intent_protected'):
            self.apply()
        with self.assertRaisesRegex(RuntimeError, 'prior_sample_not_refreshed'):
            self.apply(2)

    def test_persisted_without_bound_profile_is_not_claimed_as_refreshed(self):
        self.pilot.header_probe = lambda _: {'attempted': 1, 'persisted': 1, 'deferredBeforeIO': False}
        with self.assertRaisesRegex(RuntimeError, 'failed_or_uncertain_no_retry'):
            self.apply()
        self.assertFalse((module.ROOT / '01-closed.private.json').exists())

    def test_script_has_no_direct_production_write_or_job_operation(self):
        source = PATH.read_text(encoding='utf-8')
        self.assertEqual(source.count('pilot.header_probe(row)'), 1)
        for forbidden in ('UPDATE public.', 'DELETE FROM', 'readonly=False', '.enqueue(', '.unlink(',
                          'SIGTERM', 'forceProbe', 'start_automatic_catalog_file_audio_validation_job'):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
