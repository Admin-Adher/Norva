"""Offline checks of actual scoped-release functions; no production actions."""
import ast
import hashlib
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-scoped-capture-jobs-20260913.py'


def require(condition,code):
    if not condition:raise RuntimeError(code)


class ScopedDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        tree=ast.parse(SOURCE.read_text())
        constants={}
        for n in tree.body:
            if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id in ('OLD','NEW','FILE','SERVICES'):
                constants[n.targets[0].id]=ast.literal_eval(n.value)
        self.ns={'ROOT':self.root,'pathlib':pathlib,'require':require,'json':json,'hashlib':hashlib,**constants}
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
        exec(compile(ast.Module(body=functions,type_ignores=[]),str(SOURCE),'exec'),self.ns)

    def test_one_reviewed_rpc_change_and_eol_only_are_accepted(self):
        old=('prefix\n'+self.ns['OLD']+'\nsuffix\n').encode()
        new=old.replace(self.ns['OLD'].encode(),self.ns['NEW'].encode())
        self.assertEqual(self.ns['updated_edge_source'](old.replace(b'\n',b'\r\n'),old,new),new)
        for live,base,candidate in [(old+b'foreign',old,new),(old,old,new+b'other-change'),
            (old+old,old+old,new+new),(b'no-anchor',b'no-anchor',new)]:
            with self.assertRaises(RuntimeError):self.ns['updated_edge_source'](live,base,candidate)

    def test_runtime_controls_gateway_identity_and_protected_files_are_attested(self):
        protected=self.root/'evidence';protected.write_bytes(b'negative proof')
        controls={'flags':{'capture':False},'quarantine':'digest'}
        c={'Id':'gateway','Config':{'Image':'image'}}
        gw=types.SimpleNamespace(inspect=Mock(return_value=c),assert_clone=Mock(),binary_snapshot=Mock(return_value='binary'),
            assert_runtime=Mock(),health=Mock(return_value={}))
        self.ns.update(gw=gw,core=types.SimpleNamespace(base=types.SimpleNamespace(r=types.SimpleNamespace(controls=lambda:controls))),
            parent=types.SimpleNamespace(source_snapshot=lambda:'source'))
        plan={'controls':controls.copy(),'gateway':c,'gatewaySources':'source','binaries':'binary','runtime':{},
            'otherContainers':{},'protectedFiles':{str(protected):hashlib.sha256(protected.read_bytes()).hexdigest()}}
        self.ns['invariant'](plan);gw.assert_clone.assert_called_once()
        protected.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'protected_evidence_changed'):self.ns['invariant'](plan)

    def test_changed_flags_or_gateway_are_not_bypassed(self):
        for controls,identity,expected in [({'enabled':True},'gateway','flags_or_quarantine_changed'),
            ({'enabled':False},'foreign','gateway_changed')]:
            self.ns['core']=types.SimpleNamespace(base=types.SimpleNamespace(r=types.SimpleNamespace(controls=lambda:controls)))
            self.ns['gw']=types.SimpleNamespace(inspect=lambda:{'Id':identity})
            with self.assertRaisesRegex(RuntimeError,expected):
                self.ns['invariant']({'controls':{'enabled':False},'gateway':{'Id':'gateway'}})

    def test_edge_identity_and_complete_tree_are_verified(self):
        original={'Id':'old','Config':{'Image':'tag'},'Image':'digest'}
        current={'Id':'new','Image':'digest','State':{'Running':True,'OOMKilled':False}}
        gw=types.SimpleNamespace(inspect=lambda name:current,assert_clone=Mock())
        lib=types.SimpleNamespace(edge_expected=lambda *args:'expected',edge_root=lambda c:'root',edge_health=Mock())
        self.ns.update(gw=gw,lib=lib,edge=types.SimpleNamespace(hashes=lambda root:{'a':'after'}),saved=lambda name:{'candidateContainer':'new'})
        plan={'containers':{'edge':original},'after':{'a':'after'}}
        self.ns['verify_edge'](plan,'edge',True);gw.assert_clone.assert_called_once()
        current['Id']='foreign'
        with self.assertRaisesRegex(RuntimeError,'edge_container_not_owned'):self.ns['verify_edge'](plan,'edge',True)

    def test_recovery_waits_for_actual_idle_and_a_terminal_runner(self):
        self.ns['process_alive']=lambda phase:True;self.ns['idle']=Mock();self.ns['invariant']=Mock()
        with self.assertRaisesRegex(RuntimeError,'runner_still_active'):self.ns['recover']({})
        self.ns['idle'].assert_not_called()
        self.ns['process_alive']=lambda phase:False
        self.ns['idle'].side_effect=RuntimeError('viewer-active')
        with self.assertRaisesRegex(RuntimeError,'viewer-active'):self.ns['recover']({})
        self.ns['invariant'].assert_not_called()

    def test_recovery_refuses_foreign_alias_before_any_restore(self):
        service=self.ns['SERVICES'][1];(self.root/(service+'-receipt.private.json')).write_text('{}')
        restore=Mock()
        self.ns.update(process_alive=lambda phase:False,idle=Mock(),invariant=Mock(),
            saved=lambda name:{'candidateContainer':'new'},edge=types.SimpleNamespace(restore=restore),
            gw=types.SimpleNamespace(docker_api=lambda *args:[{'Id':'foreign','Names':['/'+service]}]))
        with self.assertRaisesRegex(RuntimeError,'foreign_edge_alias'):
            self.ns['recover']({'containers':{service:{'Id':'old'}}})
        restore.assert_not_called()

    def test_no_approval_activation_subtitle_stop_or_gateway_mutation(self):
        text=SOURCE.read_text()
        for forbidden in ('UPDATE public.admin_feature_flags','INSERT INTO public.catalog_language_capture_job_pilots',
            'os.kill(',"'docker','kill'",'captureRelease:',"'docker','build'"):
            self.assertNotIn(forbidden,text)
        self.assertIn("save('sql-attempt.private.json'",text)
        self.assertIn('A lost response is not proof of rollback',text)


if __name__=='__main__':unittest.main()
