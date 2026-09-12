"""Recovery and ownership guards execute offline; never import remote helpers."""
import ast
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-scoped-passive-dormant-20260912.py'


def require(value, code):
    if not value:
        raise RuntimeError(code)


class ScopedPassiveReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        functions = [n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef)]
        self.ns = {'ROOT': self.root, 'SERVICE': 'gateway', 'pathlib': pathlib, 'json': json, 'require': require}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'scoped-passive-guards', 'exec'), self.ns)
        self.plan = {'original': {'Id': 'old'}, 'crons': ['original']}
        self.documents = {'plan.private.json': self.plan}
        self.gw = types.SimpleNamespace(docker_api=Mock(), inspect=Mock(), assert_idle=Mock(), health=Mock())
        self.restore = Mock()
        self.restore_crons = Mock()
        self.verify = Mock()
        self.idle = Mock()
        self.ns.update(saved=lambda n: self.documents[n], invariant=Mock(), gw=self.gw,
            edge=types.SimpleNamespace(restore=self.restore), verify_gateway=self.verify,
            restore_crons=self.restore_crons, recovery_idle=self.idle)

    def receipt(self):
        (self.root/'receipt.private.json').touch()
        self.documents['receipt.private.json'] = {'candidateContainer': 'new', 'candidateName': 'new-candidate'}

    def alias(self, identity):
        self.gw.docker_api.return_value = [] if identity is None else [{'Id': identity, 'Names': ['/gateway']}]

    def test_healthy_candidate_is_kept_without_interrupting_work(self):
        self.receipt()
        self.alias('new')
        self.assertTrue(self.ns['recover']())
        self.verify.assert_called_once_with(self.plan, True)
        self.restore_crons.assert_called_once_with(self.plan)
        self.idle.assert_not_called()
        self.restore.assert_not_called()

    def test_original_without_receipt_only_resumes_crons(self):
        self.alias('old')
        self.assertFalse(self.ns['recover']())
        self.verify.assert_called_once_with(self.plan, False)
        self.restore.assert_not_called()
        self.restore_crons.assert_called_once()

    def test_alias_gap_after_first_rename_restores_exact_original(self):
        self.receipt()
        self.alias(None)
        self.assertFalse(self.ns['recover']())
        self.idle.assert_called_once_with(self.plan, self.documents['receipt.private.json'])
        self.restore.assert_called_once_with('gateway', {'containers': {'gateway': self.plan['original']}},
            self.documents['receipt.private.json'])
        self.verify.assert_called_once_with(self.plan, False)

    def test_unhealthy_candidate_is_restored_only_after_idle(self):
        self.receipt()
        self.alias('new')
        self.verify.side_effect = [RuntimeError('health_failure'), None]
        self.assertFalse(self.ns['recover']())
        self.idle.assert_called_once()
        self.restore.assert_called_once()
        self.restore_crons.assert_called_once()

    def test_active_work_prevents_rollback(self):
        self.receipt()
        self.alias(None)
        self.idle.side_effect = RuntimeError('recovery_work_active')
        with self.assertRaisesRegex(RuntimeError, 'recovery_work_active'):
            self.ns['recover']()
        self.restore.assert_not_called()
        self.restore_crons.assert_not_called()

    def test_unknown_alias_cannot_be_overwritten(self):
        self.receipt()
        self.alias('another-release')
        with self.assertRaisesRegex(RuntimeError, 'recovery_container_not_owned'):
            self.ns['recover']()
        self.restore.assert_not_called()
        self.restore_crons.assert_not_called()

    def test_missing_alias_without_receipt_fails_closed(self):
        self.alias(None)
        with self.assertRaisesRegex(RuntimeError, 'recovery_alias_missing_without_receipt'):
            self.ns['recover']()
        self.restore.assert_not_called()

    def test_recovery_inspects_owned_containers_when_alias_missing(self):
        # Run the real recovery_idle body, not its mock used by other tests.
        method = next(n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'recovery_idle')
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'recovery-idle', 'exec'), self.ns)
        self.gw.inspect.side_effect = [{'State': {'Running': False}}, {'State': {'Running': True}}]
        self.gw.health.return_value = {'synthetic': True}
        self.ns['lib'] = types.SimpleNamespace(sql=Mock(return_value=json.dumps(dict.fromkeys(
            ('playback', 'jobs', 'intake', 'selection', 'account'), 0))))
        self.ns['recovery_idle'](self.plan, {'candidateContainer': 'new'})
        self.assertEqual([c.args[0] for c in self.gw.inspect.call_args_list], ['old', 'new'])
        self.gw.assert_idle.assert_called_once_with({'synthetic': True})
        self.gw.health.assert_called_once_with({'State': {'Running': True}})

    def test_incomplete_recovery_counts_cannot_look_idle(self):
        method = next(n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'recovery_idle')
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'recovery-idle', 'exec'), self.ns)
        self.gw.inspect.return_value = {'State': {'Running': False}}
        for result in ({}, {'playback': 0}, dict.fromkeys(('playback', 'jobs', 'intake', 'selection', 'account'), False),
            {'playback': 1, 'jobs': 0, 'intake': 0, 'selection': 0, 'account': 0}):
            self.ns['lib'] = types.SimpleNamespace(sql=Mock(return_value=json.dumps(result)))
            with self.assertRaisesRegex(RuntimeError, 'recovery_work_active'):
                self.ns['recovery_idle'](self.plan, {'candidateContainer': 'new'})

    def test_no_feature_activation_job_reset_or_historical_overwrite(self):
        source = SOURCE.read_text()
        for forbidden in ('UPDATE public.', 'DELETE FROM', 'INSERT INTO public.', 'rmtree(',
            'os.kill', "'kill'", "PARENT/'plan.private.json').write", "'LANGUAGE_PASSIVE_CAPTURE_ENABLED': '1'"):
            self.assertNotIn(forbidden, source)
        self.assertIn("gw.assert_image_backed_runtime(current)", source)
        self.assertIn("native['sourceHashes'][entry.name]", source)
        self.assertIn("spawn('watch')", source)
        self.assertIn("not process_alive('run')", source)
        self.assertIn("base.previous.d.idle()", source)


if __name__ == '__main__':
    unittest.main()
