"""Test the scoped inventory extension without remote imports or Docker I/O."""
import ast
import json
import pathlib
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-finite-ts-startup-20260912.py'


class FiniteTsDeploymentTests(unittest.TestCase):
    def test_inventory_extension_preserves_historical_module_contract(self):
        nodes = [n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'source_snapshot']
        original = {'index.js': 'index-hash'}
        gw = types.SimpleNamespace(source_snapshot=Mock(side_effect=lambda _: dict(original)), run=Mock(return_value='null'))
        ns = {'gw': gw, 'op': types.SimpleNamespace(SERVICE='gateway'), 'json': json}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'ts-inventory', 'exec'), ns)
        self.assertEqual(ns['source_snapshot'](), {'index.js':'index-hash', 'finite-ts-startup.js':None})
        gw.run.return_value = '"new-hash"'
        self.assertEqual(ns['source_snapshot']('candidate'), {'index.js':'index-hash', 'finite-ts-startup.js':'new-hash'})
        self.assertEqual(original, {'index.js':'index-hash'})
        self.assertEqual(gw.run.call_args.args[0][2], 'candidate')

    def test_operator_uses_new_inventory_without_rewriting_history(self):
        source = SOURCE.read_text()
        self.assertIn('op.verify_gateway = verify_gateway', source)
        self.assertIn("source_snapshot() == plan['after' if candidate else 'before']", source)
        self.assertIn('op.__file__ = __file__', source)
        self.assertIn("native['sourceHashes'][entry.name]", source)
        for forbidden in ('gw.MODULES =', 'gw.source_snapshot =', 'UPDATE public.', 'DELETE FROM', 'rmtree('):
            self.assertNotIn(forbidden, source)

    def test_subtitle_followup_attests_both_extra_modules_and_current_parent(self):
        source = SOURCE.with_name('deploy-subtitle-master-20260912.py').read_text()
        nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'source_snapshot']
        gw = types.SimpleNamespace(source_snapshot=Mock(return_value={'index.js':'index-hash'}),
            run=Mock(return_value='{"finite-ts-startup.js":"ts-hash","sharedHlsTracks.js":"shared-hash"}'))
        ns = {'gw':gw,'op':types.SimpleNamespace(SERVICE='gateway'),'json':json}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'subtitle-inventory','exec'),ns)
        self.assertEqual(ns['source_snapshot'](),{'index.js':'index-hash','finite-ts-startup.js':'ts-hash','sharedHlsTracks.js':'shared-hash'})
        self.assertIn('live.op.verify_gateway(plan, True)',source)
        self.assertIn("FILES = ('index.js', 'sharedHlsTracks.js')",source)
        self.assertIn('op.__file__ = __file__',source)


if __name__ == '__main__':
    unittest.main()
