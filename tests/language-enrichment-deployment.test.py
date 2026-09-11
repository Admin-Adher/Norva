"""Execute real operator functions with fakes; no Docker, network or production."""
import ast
import copy
import json
import pathlib
import re
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/deploy-language-enrichment-access-20260911.py'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def functions():
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    # Importing production helpers is deliberately excluded. Function bodies
    # themselves are compiled verbatim, not duplicated in the tests.
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    scope = {'require': require, 'json': json, 're': re,
             'SERVICES': ('edge-a', 'edge-b'), 'CRONS': ('fleet', 'worker')}
    exec(compile(tree, str(SOURCE), 'exec'), scope)
    return scope


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.op = functions()
        self.plan = {'crons': [
            {'id': 84, 'name': 'fleet', 'spec': 'a' * 32, 'active': True},
            {'id': 159, 'name': 'worker', 'spec': 'b' * 32, 'active': False}]}

    def test_idle_requires_all_three_numeric_zero_counts(self):
        self.op['gw'] = types.SimpleNamespace(health=Mock(), assert_idle=Mock())
        self.op['lib'] = types.SimpleNamespace(sql=Mock())
        good = {'playback': 0, 'jobs': 0, 'intake': 0}
        self.op['lib'].sql.return_value = json.dumps(good)
        self.op['idle']()
        for bad in ({}, {'playback': 0}, {**good, 'jobs': False},
                    {**good, 'jobs': 1}, {**good, 'intake': 1}, {**good, 'playback': 1}):
            self.op['lib'].sql.return_value = json.dumps(bad)
            with self.assertRaisesRegex(RuntimeError, 'background_or_playback_active'):
                self.op['idle']()

    def test_cron_restore_preserves_original_inactive_state_and_specs(self):
        paused = [{**j, 'active': False} for j in self.plan['crons']]
        self.op['crons'] = Mock(side_effect=[paused, self.plan['crons']])
        self.op['lib'] = types.SimpleNamespace(sql=Mock())
        self.op['alter_crons'](self.plan, False)
        sql = self.op['lib'].sql.call_args.args[0]
        self.assertIn('cron.alter_job(84,active:=true)', sql)
        self.assertIn('cron.alter_job(159,active:=false)', sql)
        self.assertEqual(sql.count('FOR UPDATE'), 2)
        self.assertTrue(sql.startswith('BEGIN;'))
        self.assertTrue(sql.endswith('COMMIT;'))
        self.assertEqual(self.op['lib'].sql.call_args.kwargs, {'write': True})
        for forbidden in ('DELETE ', 'UPDATE public.', 'INSERT ', 'cron.schedule'):
            self.assertNotIn(forbidden, sql)

    def test_cron_drift_blocks_writes(self):
        drift = copy.deepcopy(self.plan['crons'])
        drift[0]['spec'] = 'c' * 32
        self.op['crons'] = Mock(return_value=drift)
        self.op['lib'] = types.SimpleNamespace(sql=Mock())
        with self.assertRaisesRegex(RuntimeError, 'cron_spec_changed'):
            self.op['alter_crons'](self.plan, True)
        self.op['lib'].sql.assert_not_called()

    def wire_release(self):
        events = []
        self.op.update({
            'saved': Mock(return_value=self.plan),
            'crons': Mock(return_value=[{**j, 'active': False} for j in self.plan['crons']]),
            'idle': Mock(side_effect=lambda: events.append('idle')),
            'time': types.SimpleNamespace(sleep=Mock()),
            'verify_invariants': Mock(side_effect=lambda plan: events.append('invariants')),
            'activate': Mock(side_effect=lambda name, plan: events.append('activate:' + name)),
            'verify_service': Mock(side_effect=lambda name, plan, candidate=True:
                events.append(('new:' if candidate else 'old:') + name)),
            'alter_crons': Mock(side_effect=lambda plan, pause: events.append('pause' if pause else 'resume')),
            'verify': Mock(side_effect=lambda: events.append('verified')),
            'edge': types.SimpleNamespace(restore=Mock(side_effect=lambda name, plan, receipt:
                events.append('restore:' + name)))})
        return events

    def test_success_rolls_both_before_resuming(self):
        events = self.wire_release()
        self.op['deploy']()
        self.assertEqual(events, ['idle', 'idle', 'invariants', 'activate:edge-a',
            'activate:edge-b', 'new:edge-a', 'new:edge-b', 'invariants', 'resume', 'verified'])

    def test_second_replica_failure_restores_first_then_crons(self):
        events = self.wire_release()
        def activate(name, plan):
            events.append('activate:' + name)
            if name == 'edge-b':
                raise RuntimeError('second_candidate_failed_original_restored')
        self.op['activate'] = activate
        with self.assertRaisesRegex(RuntimeError, 'release_failed_originals_and_crons_restored'):
            self.op['deploy']()
        self.assertEqual(events[-4:], ['restore:edge-a', 'old:edge-a', 'old:edge-b', 'resume'])
        self.op['verify'].assert_not_called()

    def test_busy_preflight_does_not_stop_or_mutate_any_replica(self):
        self.wire_release()
        self.op['idle'] = Mock(side_effect=RuntimeError('background_or_playback_active'))
        with self.assertRaises(RuntimeError):
            self.op['deploy']()
        self.op['activate'].assert_not_called()
        self.op['edge'].restore.assert_not_called()
        # The explicit recovery command is used after an interrupted drain.
        self.op['alter_crons'].assert_not_called()

    def test_resume_requires_matching_replicas_and_invariants(self):
        events = self.wire_release()
        self.op['resume']()
        self.assertEqual(events, ['new:edge-a', 'new:edge-b', 'invariants', 'resume', 'verified'])
        self.wire_release()
        self.op['verify_service'] = Mock(side_effect=RuntimeError('replica_mismatch'))
        with self.assertRaises(RuntimeError):
            self.op['resume']()
        self.op['alter_crons'].assert_not_called()

    def test_operator_never_removes_containers_or_changes_flags_or_quarantine(self):
        source = SOURCE.read_text(encoding='utf-8')
        for forbidden in ("'rm'", "'kill'", 'rmtree(', 'DELETE FROM',
                          'UPDATE public.', 'INSERT INTO public.', 'cron.unschedule'):
            self.assertNotIn(forbidden, source)
        compile(source, str(SOURCE), 'exec')


if __name__ == '__main__':
    unittest.main()
