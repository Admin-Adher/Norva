"""Execute the operator's real pure/closure functions without production imports."""
import ast
import copy
import datetime
import hashlib
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-independent-pilot20-20260912.py'
OLD = SOURCE.with_name('run-unknown-vod-pilot-20260911.py')


def require(condition, code='guard_failed'):
    if not condition:
        raise RuntimeError(code)


def functions():
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    scope = dict(require=require, copy=copy, json=json, datetime=datetime, MAX_FILES=20,
        sha=lambda raw: hashlib.sha256(raw.encode() if isinstance(raw, str) else raw).hexdigest())
    exec(compile(tree, str(SOURCE), 'exec'), scope)
    chooser = next(node for node in ast.parse(OLD.read_text(encoding='utf-8')).body
        if isinstance(node, ast.FunctionDef) and node.name == 'choose')
    helper = dict(require=require, MAX_FILES=20)
    exec(compile(ast.Module(body=[chooser], type_ignores=[]), str(OLD), 'exec'), helper)
    scope['pilot'] = types.SimpleNamespace(choose=helper['choose'],
        cache_result=lambda value: value.get('result', 'incomplete_tracks'))
    return scope


def row(number, provider=0, mapped=True):
    return dict(identity_key='provider-'+str(provider), external_id='file-'+str(number),
        variant_id='variant-'+str(number), user_id='user-'+str(provider), source_id='source-'+str(provider),
        requested_example=False, has_track_map=mapped, preference=number)


class IndependentPilotTests(unittest.TestCase):
    def setUp(self):
        self.op = functions()
        self.epoch = datetime.datetime(2026, 9, 12, tzinfo=datetime.timezone.utc).timestamp()

    def test_prior_file_is_excluded_even_from_another_account(self):
        sample = row(1)
        key = self.op['file_key'](sample)
        same = dict(sample, source_id='another-source', user_id='another-user', variant_id='another-variant')
        self.assertEqual(self.op['candidate_reason'](same, {}, {key}, self.epoch), 'prior_cohort')

    def test_every_existing_job_is_protected_not_only_quarantines(self):
        for state in ('queued', 'running', 'retry_wait', 'completed', 'verified', 'failed', 'expired', 'cancelled'):
            value = dict(job=dict(state=state))
            self.assertEqual(self.op['candidate_reason'](row(1), value, set(), self.epoch), 'existing_job_protected')
        self.assertEqual(self.op['candidate_reason'](row(1), {'job': {'quarantined': True}}, set(), self.epoch),
            'existing_job_protected')

    def test_missing_source_and_completed_metadata_never_selected(self):
        reason = self.op['candidate_reason']
        self.assertEqual(reason(row(1), None, set(), self.epoch), 'source_unavailable')
        for result in ('identified_from_tracks', 'verified'):
            self.assertEqual(reason(row(1), {'result': result}, set(), self.epoch), 'already_identified')

    def test_provider_and_file_cooldowns_and_malformed_dates_fail_closed(self):
        for field in ('probeCircuitRetryAt', 'retryAt'):
            value = {field: '2026-09-13T00:00:00Z'}
            self.assertIn('cooldown', self.op['candidate_reason'](row(1), value, set(), self.epoch))
            value[field] = '2026-09-11T00:00:00Z'
            self.assertIsNone(self.op['candidate_reason'](row(1), value, set(), self.epoch))
            for date in ('broken', '2026-09-13T00:00:00', 42):
                value[field] = date
                self.assertEqual(self.op['candidate_reason'](row(1), value, set(), self.epoch), 'invalid_retry_time')

    def test_new_cohort_has_exact_twenty_unique_files_and_original_rows_unchanged(self):
        rows = [row(n, provider=n % 5, mapped=n < 14) for n in range(40)]
        before = copy.deepcopy(rows)
        excluded = {self.op['file_key'](rows[0]), self.op['file_key'](rows[1])}
        values = {x['variant_id']: {'result': 'incomplete_tracks'} for x in rows}
        selected, rejected = self.op['select_cohort'](rows, values, excluded, self.epoch)
        self.assertEqual(len(selected), 20)
        self.assertEqual(len({x['fileKey'] for x in selected}), 20)
        self.assertFalse(excluded & {x['fileKey'] for x in selected})
        self.assertEqual([x['sample'] for x in selected], list(range(1, 21)))
        self.assertEqual(len({x['identity_key'] for x in selected}), 5)
        self.assertEqual(rejected, {'prior_cohort': 2})
        self.assertEqual(rows, before)

    def test_insufficient_unique_or_admissible_cohort_does_not_fill_with_old_files(self):
        rows = [row(n) for n in range(19)]
        values = {x['variant_id']: {'result': 'incomplete_tracks'} for x in rows}
        with self.assertRaisesRegex(RuntimeError, 'insufficient_distinct_eligible_files'):
            self.op['select_cohort'](rows, values, set(), self.epoch)
        rows += [dict(rows[0], variant_id='duplicate')]
        values['duplicate'] = {'result': 'incomplete_tracks'}
        with self.assertRaisesRegex(RuntimeError, 'insufficient_distinct_eligible_files'):
            self.op['select_cohort'](rows, values, set(), self.epoch)

    def test_replacement_has_two_idle_checks_before_stop_and_keeps_old_container(self):
        with tempfile.TemporaryDirectory(prefix='norva-pilot-unit-') as folder:
            events = []
            self.op.update(ROOT=pathlib.Path(folder), CONTAINER_PREFIX='unique-new-pilot', IMAGE='image',
                time=types.SimpleNamespace(sleep=Mock()), stamp=lambda: 'now', save=Mock())
            self.op['d'] = types.SimpleNamespace(SERVICES=['gateway'], idle=Mock(side_effect=lambda: events.append('idle')),
                edge=types.SimpleNamespace(restore=Mock()))
            def run(args):
                events.append(args[1])
            self.op['gw'] = types.SimpleNamespace(inspect=Mock(return_value={'Id': 'old'}),
                docker_api=Mock(return_value={'Id': 'candidate'}), clone_payload=Mock(), assert_clone=Mock(), run=run)
            self.op['r'] = types.SimpleNamespace(environment=Mock(), verify=Mock())
            self.op['replace_gateway']({}, True, 'before-resume')
            self.assertEqual(events[:3], ['idle', 'idle', 'stop'])
            self.assertNotIn('rm', events)
            self.op['d'].edge.restore.assert_not_called()
            self.assertIn('unique-new-pilot', self.op['gw'].docker_api.call_args.args[1])

    def wire_finish(self, root, *, installed=False, running=False):
        plan = {'expiresEpoch': self.epoch+100, 'rows': list(range(20))}
        state = {'runtimeStatus': 'stopped', 'stoppedReason': 'cohort_quarantine_requires_review'}
        values = {'plan.private.json': plan, 'begin.private.json': {'launchDeadline': self.epoch+50}}
        self.op.update(ROOT=root, time=types.SimpleNamespace(time=lambda: self.epoch),
            saved=lambda name: values[name], invariant=Mock(), stamp=lambda: 'now', save=Mock(),
            prior=types.SimpleNamespace(alter_crons=Mock()), sql=Mock(), baseline=types.SimpleNamespace(verify=Mock()),
            replace_gateway=Mock())
        self.op['pilot'].ROOT = root/'pilot'
        self.op['pilot'].private = Mock(return_value=state)
        self.op['r'] = types.SimpleNamespace(process_active=Mock(return_value=running), verify=Mock(),
            fleet=types.SimpleNamespace(literal=lambda value: "'"+value+"'"))
        self.op['d'] = types.SimpleNamespace(FLAGS=['new-a', 'new-b'], SERVICES=['gateway'], idle=Mock())
        self.op['gw'] = types.SimpleNamespace(health=Mock(return_value={'languageCaptureBuffer':
            {'ready': True, 'entries': 0, 'bytes': 0, 'reservations': 0, 'computations': 0}}), inspect=Mock())
        if installed:
            (root/'deployed.private.json').touch()
            (root/'audio-private').mkdir()
        return values

    def test_predeployment_closure_verifies_current_baseline_before_resuming_crons(self):
        with tempfile.TemporaryDirectory(prefix='norva-pilot-unit-') as folder:
            self.wire_finish(pathlib.Path(folder))
            self.assertTrue(self.op['finish']())
            self.op['baseline'].verify.assert_called_once_with(False)
            self.op['replace_gateway'].assert_not_called()
            self.op['prior'].alter_crons.assert_called_once()

    def test_live_operator_or_retained_audio_blocks_closure(self):
        with tempfile.TemporaryDirectory(prefix='norva-pilot-unit-') as folder:
            self.wire_finish(pathlib.Path(folder), installed=True, running=True)
            with self.assertRaisesRegex(RuntimeError, 'waiting_for_independent_operator_exit'):
                self.op['finish']()
            self.op['prior'].alter_crons.assert_not_called()
            self.op['r'].process_active.return_value = False
            self.op['gw'].health.return_value['languageCaptureBuffer']['entries'] = 1
            with self.assertRaisesRegex(RuntimeError, 'waiting_for_private_audio_expiry'):
                self.op['finish']()
            self.op['replace_gateway'].assert_not_called()

    def test_missing_active_buffer_counters_are_not_treated_as_empty(self):
        with tempfile.TemporaryDirectory(prefix='norva-pilot-unit-') as folder:
            self.wire_finish(pathlib.Path(folder), installed=True)
            self.op['gw'].health.return_value = {'languageCaptureBuffer': {'ready': False}}
            with self.assertRaisesRegex(RuntimeError, 'private_buffer_state_missing'):
                self.op['finish']()
            self.op['replace_gateway'].assert_not_called()

    def test_successful_closure_disables_only_new_flags_and_preserves_prior_results(self):
        with tempfile.TemporaryDirectory(prefix='norva-pilot-unit-') as folder:
            self.wire_finish(pathlib.Path(folder), installed=True)
            self.assertTrue(self.op['finish']())
            self.op['replace_gateway'].assert_called_once()
            query = self.op['sql'].call_args.args[0]
            self.assertIn('UPDATE public.admin_feature_flags SET enabled=false', query)
            self.assertNotIn('validation_jobs', query)
            self.op['prior'].alter_crons.assert_called_once()

    def test_scope_constants_and_passive_remain_bounded(self):
        source = SOURCE.read_text(encoding='utf-8')
        self.assertIn('MAX_FILES = 20', source)
        self.assertIn('MAX_SECONDS = 24*3600', source)
        self.assertIn("'LANGUAGE_PASSIVE_CAPTURE_ENABLED': '0'", source)
        self.assertIn("'SELECTION_ENRICHMENT_POLICY_JSON': ''", source)
        for forbidden in ('UPDATE public.catalog_', 'DELETE FROM', 'rmtree(', "'kill'", 'verify=False'):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
