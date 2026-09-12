"""Execute the new rolling-release guards offline, with no remote imports."""
import ast
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-enrichment-postpilot-20260912.py'


def require(value, code):
    if not value:
        raise RuntimeError(code)


class PostpilotReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        body = [n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef)]
        self.ns = {'ROOT': self.root, 'require': require, 'pathlib': pathlib, 'json': json}
        exec(compile(ast.Module(body=body, type_ignores=[]), 'postpilot-release-functions', 'exec'), self.ns)
        self.plan = {'containers': {'a': {'Id': 'old-a'}, 'b': {'Id': 'old-b'}}, 'crons': ['original']}
        self.documents = {'plan.private.json': self.plan}
        self.r = types.SimpleNamespace(SERVICES=('a', 'b'), saved=lambda name: self.documents[name], resume=Mock())
        self.idle = Mock()
        self.gw = types.SimpleNamespace(docker_api=Mock())
        self.restore = Mock()
        self.ns.update(r=self.r, gw=self.gw, invariant=Mock(), verify_service=Mock(),
            previous=types.SimpleNamespace(d=types.SimpleNamespace(idle=self.idle)), edge=types.SimpleNamespace(restore=self.restore))

    def receipts(self, names=('a', 'b')):
        for name in names:
            filename = name+'-receipt.private.json'
            (self.root/filename).touch()
            self.documents[filename] = {'candidateContainer': 'new-'+name}

    def aliases(self, **values):
        self.gw.docker_api.return_value = [{'Id': value, 'Names': ['/'+name]} for name, value in values.items()]

    def test_completed_candidates_resume_without_rolling_them_again(self):
        self.receipts()
        self.aliases(a='new-a', b='new-b')
        self.assertTrue(self.ns['recover']())
        self.r.resume.assert_called_once_with(True)
        self.idle.assert_not_called()
        self.restore.assert_not_called()

    def test_partial_release_restores_only_its_candidate_after_drain(self):
        self.receipts(('a',))
        self.aliases(a='new-a', b='old-b')
        self.assertFalse(self.ns['recover']())
        self.idle.assert_called_once()
        self.restore.assert_called_once_with('a', self.plan, self.documents['a-receipt.private.json'])
        self.r.resume.assert_called_once_with(False)

    def test_crash_between_renames_restores_the_owned_original(self):
        self.receipts(('a',))
        self.aliases(b='old-b')
        self.assertFalse(self.ns['recover']())
        self.restore.assert_called_once_with('a', self.plan, self.documents['a-receipt.private.json'])

    def test_unknown_container_never_gets_replaced(self):
        self.receipts()
        self.aliases(a='another-release', b='old-b')
        with self.assertRaisesRegex(RuntimeError, 'recovery_container_not_owned'):
            self.ns['recover']()
        self.restore.assert_not_called()
        self.r.resume.assert_not_called()

    def test_missing_alias_without_receipt_fails_closed(self):
        self.aliases(b='old-b')
        with self.assertRaisesRegex(RuntimeError, 'recovery_alias_missing_without_receipt'):
            self.ns['recover']()
        self.restore.assert_not_called()

    def test_unhealthy_candidates_restore_in_reverse_order(self):
        self.receipts()
        self.aliases(a='new-a', b='new-b')
        self.ns['verify_service'].side_effect = RuntimeError('health_failed')
        self.assertFalse(self.ns['recover']())
        self.assertEqual([c.args[0] for c in self.restore.call_args_list], ['b', 'a'])
        self.r.resume.assert_called_once_with(False)

    def test_busy_recovery_never_stops_a_container(self):
        self.receipts(('a',))
        self.aliases(a='new-a', b='old-b')
        self.idle.side_effect = RuntimeError('viewer_active')
        with self.assertRaisesRegex(RuntimeError, 'viewer_active'):
            self.ns['recover']()
        self.restore.assert_not_called()
        self.r.resume.assert_not_called()

    def test_source_cannot_reset_jobs_change_flags_or_delete_prior_evidence(self):
        source = SOURCE.read_text()
        for forbidden in ('UPDATE public.', 'DELETE FROM', 'INSERT INTO public.', 'rmtree(',
                          "'rm'", "'kill'", 'os.kill', "PARENT/'run-enrichment-pilot20-20260911.py').write"):
            self.assertNotIn(forbidden, source)
        self.assertIn("spawn('watch')", source)
        self.assertIn("not process_alive('run')", source)
        self.assertIn("'run-enrichment-pilot20-20260911.py').read_bytes()) == RUNNER_SHA", source)


if __name__ == '__main__':
    unittest.main()
