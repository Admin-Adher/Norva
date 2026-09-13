"""Run actual diagnostic-rollout functions offline, without Docker or SQL."""
import ast
import io
import json
import pathlib
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-profile-share-diagnostics-20260913.py'


def require(condition,code):
    if not condition:raise RuntimeError(code)


class DiagnosticDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        tree=ast.parse(SOURCE.read_text())
        self.base=types.SimpleNamespace(FILE='norva-playback/index.ts',SERVICES=('edge-a','edge-b'))
        self.ns={'ROOT':self.root,'SUFFIX':'profile-share-diagnostics-20260913','base':self.base,
            'require':require,'tarfile':tarfile,'pathlib':pathlib,'time':types.SimpleNamespace(time=lambda:100,sleep=Mock())}
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
        exec(compile(ast.Module(body=functions,type_ignores=[]),str(SOURCE),'exec'),self.ns)

    def archive(self,entries):
        with tarfile.open(self.root/'candidate.tar','w') as archive:
            for name,data,kind in entries:
                info=tarfile.TarInfo(name);info.type=kind;info.size=len(data)
                archive.addfile(info,io.BytesIO(data))

    def test_only_one_bounded_regular_playback_file_is_read(self):
        name='supabase/functions/norva-playback/index.ts'
        self.archive([(name,b'a\r\nb',tarfile.REGTYPE)])
        self.assertEqual(self.ns['archive_payload']('candidate'),b'a\nb')
        for entries in [[('../outside',b'a',tarfile.REGTYPE)],[(name,b'',tarfile.REGTYPE)],
            [(name,b'a',tarfile.SYMTYPE)],[(name,b'a',tarfile.REGTYPE),(name,b'b',tarfile.REGTYPE)],
            [(name,b'x'*4000000,tarfile.REGTYPE)]]:
            self.archive(entries)
            with self.assertRaisesRegex(RuntimeError,'archive_scope'):self.ns['archive_payload']('candidate')

    def test_source_baseline_and_diagnostic_identity_are_checked(self):
        source=b'old\nsource'
        candidate=b'function recordFinalGatewayProfileShareDiagnostic( event: "final_gateway_profile_share" onDiagnostic: diagnose,'
        self.assertEqual(self.ns['source_delta'](source.replace(b'\n',b'\r\n'),source,candidate),candidate)
        with self.assertRaisesRegex(RuntimeError,'edge_baseline_drift'):self.ns['source_delta'](b'foreign',source,candidate)
        for old,new in [(candidate,candidate),(source,b'no diagnostics'),(source,candidate+candidate)]:
            with self.assertRaisesRegex(RuntimeError,'diagnostic_candidate_mismatch'):
                self.ns['source_delta'](old,old,new)

    def configure_run(self):
        plan={'crons':{'a':True,'b':True}}
        writes=[];self.ns['save']=lambda name,value:writes.append((name,value))
        self.ns['saved']=lambda name:plan if name=='plan.private.json' else {'deadline':1000}
        alters=Mock()
        self.base.core=types.SimpleNamespace(base=types.SimpleNamespace(r=types.SimpleNamespace(alter_crons=alters,crons=lambda:plan['crons'])))
        for name in ('invariant','verify_sql','idle','verify_edge'):setattr(self.base,name,Mock())
        self.base.process_alive=lambda phase:True
        self.ns['activate']=Mock()
        return plan,writes,alters

    def test_success_restores_crons_and_reports_no_sql_or_gateway_change(self):
        plan,writes,alters=self.configure_run();self.ns['run']()
        self.assertEqual(alters.call_args_list[0].args,(plan,True))
        self.assertEqual(alters.call_args_list[-1].args,(plan,False))
        self.assertEqual(self.ns['activate'].call_args_list[0].args,(plan,'edge-a'))
        self.assertEqual(self.ns['activate'].call_args_list[1].args,(plan,'edge-b'))
        self.assertEqual(writes,[('closed.private.json',{'at':100,'updated':True,'sqlChanged':False,
            'gatewayChanged':False,'cronsRestored':True,'approvals':0})])

    def test_missing_guard_records_recovery_before_any_activation(self):
        _,writes,_=self.configure_run();self.base.process_alive=lambda phase:False
        with self.assertRaisesRegex(RuntimeError,'guard_missing'):self.ns['run']()
        self.ns['activate'].assert_not_called()
        self.assertEqual(writes,[('failed.private.json',{'at':100,'requiresRecovery':True})])

    def test_activation_failure_is_not_a_success_receipt(self):
        _,writes,_=self.configure_run();self.ns['activate'].side_effect=RuntimeError('unhealthy')
        with self.assertRaisesRegex(RuntimeError,'unhealthy'):self.ns['run']()
        self.assertEqual([name for name,_ in writes],['failed.private.json'])

    def test_script_reuses_owned_recovery_but_never_applies_sql(self):
        text=SOURCE.read_text()
        self.assertIn('base.stage,base.activate,base.run=stage,activate,run',text)
        self.assertIn('base.ROOT,base.__file__=ROOT,__file__',text)
        self.assertIn("previous.verify_edge(old_plan,name,True)",text)
        self.assertIn("old_plan['protectedFiles']",text)
        for forbidden in ('apply_sql(',"'sql-attempt.private.json'",'write=True','os.kill(',"'docker','kill'",'INSERT INTO','UPDATE public.'):
            self.assertNotIn(forbidden,text)


if __name__=='__main__':unittest.main()
