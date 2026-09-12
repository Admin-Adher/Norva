"""Recovery ownership and no-interruption tests; no Docker/SSH imports."""
import ast
import pathlib
import types
import unittest
from unittest.mock import Mock

SOURCE=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-observed-container-hint-20260912.py'


class RecoveryTests(unittest.TestCase):
    def fixture(self, current, receipts, unhealthy=False, busy=False):
        plan={'edges':{name:{'Id':'old-'+name} for name in ('edge1','edge2')}}
        saved={'plan.private.json':plan,**{n+'-receipt.private.json':{'candidateContainer':'new-'+n} for n in receipts}}
        class Root:
            def __truediv__(self,name):return types.SimpleNamespace(exists=lambda:name in saved)
        def require(value,reason):
            if not value:raise RuntimeError(reason)
        op=types.SimpleNamespace(saved=lambda n:saved[n],restore_crons=Mock(),base=types.SimpleNamespace(previous=types.SimpleNamespace(d=types.SimpleNamespace(idle=Mock(side_effect=RuntimeError('busy') if busy else None)))))
        edge=types.SimpleNamespace(restore=Mock());invariant=Mock(side_effect=[RuntimeError('unhealthy'),None] if unhealthy else None)
        gw=types.SimpleNamespace(docker_api=Mock(return_value=[{'Id':value,'Names':['/'+name]} for name,value in current.items() if value]))
        nodes=[n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='recover']
        env={'ROOT':Root(),'op':op,'gw':gw,'edge':edge,'require':require,'EDGES':('edge1','edge2'),'invariant':invariant,'verify_gateway':Mock()}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'recovery','exec'),env)
        return env,op,edge

    def test_complete_healthy_rollout_does_not_stop_anything(self):
        env,op,edge=self.fixture({'edge1':'new-edge1','edge2':'new-edge2'},('edge1','edge2'))
        self.assertTrue(env['recover']());edge.restore.assert_not_called();op.base.previous.d.idle.assert_not_called();op.restore_crons.assert_called_once()

    def test_partial_or_rename_gap_restores_only_receipted_edge(self):
        for identity in ('new-edge1',None):
            env,op,edge=self.fixture({'edge1':identity,'edge2':'old-edge2'},('edge1',))
            self.assertFalse(env['recover']());edge.restore.assert_called_once();self.assertEqual(edge.restore.call_args.args[0],'edge1');op.base.previous.d.idle.assert_called_once()

    def test_foreign_container_is_never_restored_or_stopped(self):
        env,op,edge=self.fixture({'edge1':'foreign','edge2':'old-edge2'},('edge1',))
        with self.assertRaisesRegex(RuntimeError,'recovery_not_owned'):env['recover']()
        edge.restore.assert_not_called();op.restore_crons.assert_not_called()

    def test_unhealthy_rollout_waits_for_real_work_before_recovery(self):
        env,op,edge=self.fixture({'edge1':'new-edge1','edge2':'new-edge2'},('edge1','edge2'),unhealthy=True,busy=True)
        with self.assertRaisesRegex(RuntimeError,'busy'):env['recover']()
        edge.restore.assert_not_called();op.restore_crons.assert_not_called()

if __name__=='__main__':unittest.main()
