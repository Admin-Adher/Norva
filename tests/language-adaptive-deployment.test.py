"""Production privileges must match production, not the synthetic DB owner."""
import ast
import copy
import pathlib
import types
import unittest
import tempfile

TREE=ast.parse((pathlib.Path(__file__).parents[1]/'ops/hetzner/scripts/deploy-lid-adaptive-quota-20260911.py').read_text())
FUNCTION=next(node for node in TREE.body if isinstance(node,ast.FunctionDef) and node.name=='verified_database')


class DeploymentProof(unittest.TestCase):
    def fixture(self):
        before={'signature':'worker(uuid)','owner':'supabase_admin','acl':['private'],'definition':'old'}
        after={**before,'owner':'postgres','acl':['fixture-private'],'definition':'new'}
        live={**before,'definition':'new'}
        def require(value,message):
            if not value:raise RuntimeError(message)
        context={'require':require,'fleet':types.SimpleNamespace(definitions=lambda:[live]),'sql':lambda text:'t'}
        exec(compile(ast.Module(body=[copy.deepcopy(FUNCTION)],type_ignores=[]),'<fixture>','exec'),context)
        return context,{'before':[before],'after':[after]},live

    def test_original_production_owner_and_acl_are_preserved(self):
        context,proof,_=self.fixture();context['verified_database'](proof)

    def test_unexpected_body_rejected(self):
        context,proof,live=self.fixture();live['definition']='unexpected'
        with self.assertRaisesRegex(RuntimeError,'migration_function_mismatch'):context['verified_database'](proof)

    def test_privilege_drift_rejected(self):
        context,proof,live=self.fixture();live['acl']=['PUBLIC']
        with self.assertRaisesRegex(RuntimeError,'privileges_changed'):context['verified_database'](proof)

    def test_public_capacity_helpers_rejected(self):
        context,proof,_=self.fixture();context['sql']=lambda text:'f'
        with self.assertRaisesRegex(RuntimeError,'capacity_permissions_failed'):context['verified_database'](proof)

    def test_repeated_snapshot_retains_old_receipt(self):
        function=next(node for node in TREE.body if isinstance(node,ast.FunctionDef) and node.name=='save_snapshot')
        with tempfile.TemporaryDirectory(prefix='norva-quota-proof-') as directory:
            root=pathlib.Path(directory)
            (root/'proof.json').write_text('old')
            context={'ROOT':root,'gw':types.SimpleNamespace(safe_file=lambda folder,name:folder/name),
                'time':types.SimpleNamespace(time_ns=lambda:1),'save':lambda name,value:(root/name).write_text(value)}
            exec(compile(ast.Module(body=[copy.deepcopy(function)],type_ignores=[]),'<fixture>','exec'),context)
            context['save_snapshot']('proof.json','new')
            self.assertEqual((root/'proof.json.history-1').read_text(),'old')
            self.assertEqual((root/'proof.json').read_text(),'new')


if __name__=='__main__':unittest.main()
