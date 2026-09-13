"""Offline checks of actual QoS release/native operator functions, never production."""
import ast
import copy
import contextlib
import hashlib
import io
import json
import pathlib
import re
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock

SCRIPTS=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts'
DEPLOY=SCRIPTS/'deploy-passive-qos-diagnostics-20260913.py'
NATIVE=SCRIPTS/'test-passive-qos-diagnostics-native-20260913.py'


def require(value,code):
    if not value:raise RuntimeError(code)


def functions(source,namespace):
    nodes=[node for node in ast.parse(source.read_text()).body if isinstance(node,ast.FunctionDef)]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'),namespace)


class QosDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.current={'Id':'new','Image':'base','State':{'Running':True,'OOMKilled':False},'RestartCount':0}
        self.health={'ok':True,'languageEnrichmentPilot':{'mode':'disabled','files':0,'passiveSources':0}}
        self.plan={'original':{'Id':'old','Config':{'Image':'old-tag'}},'imageIdentity':'new-image',
            'originalImageIdentity':'old-image','before':{'index.js':'old'},'after':{'index.js':'new'},'runtime':{},'binaries':{}}
        self.gw=types.SimpleNamespace(inspect=Mock(side_effect=lambda *_:self.current),assert_clone=Mock(),
            assert_container_image=Mock(),binary_snapshot=Mock(return_value={}),assert_runtime=Mock(),
            health=Mock(side_effect=lambda:self.health),assert_image_backed_runtime=Mock(),run=Mock())
        self.ns={'ROOT':self.root,'gw':self.gw,'require':require,'IMAGE':'candidate','json':json,'re':re,
            'pathlib':pathlib,'sys':types.SimpleNamespace(argv=['operator','stage','a'*40]),
            'live':types.SimpleNamespace(verify=Mock(),source_snapshot=lambda:self.plan['after']),
            'op':types.SimpleNamespace(SERVICE='gateway',saved=lambda name:{'candidateContainer':'new'})}
        functions(DEPLOY,self.ns)

    def test_owned_image_sources_and_runtime_checked(self):
        self.ns['verify_gateway'](self.plan,True)
        self.gw.assert_clone.assert_called_once_with(self.plan['original'],self.current,'candidate')
        self.gw.assert_container_image.assert_called_once_with(self.current,'new-image')
        self.gw.assert_runtime.assert_called_once_with(self.health,{})

    def test_foreign_container_and_source_drift_rejected(self):
        self.current['Id']='foreign'
        with self.assertRaisesRegex(RuntimeError,'gateway_container_not_owned'):
            self.ns['verify_gateway'](self.plan,True)
        self.current['Id']='new';self.ns['live'].source_snapshot=lambda:{'index.js':'drift'}
        with self.assertRaisesRegex(RuntimeError,'gateway_source_changed'):
            self.ns['verify_gateway'](self.plan,True)

    def test_no_automatic_activation(self):
        for key,value in [('mode','pilot'),('files',1),('passiveSources',1)]:
            old=copy.deepcopy(self.health);self.health['languageEnrichmentPilot'][key]=value
            with self.assertRaisesRegex(RuntimeError,'dormant_admission_changed'):
                self.ns['verify_gateway'](self.plan,True)
            self.health=old

    def test_wrong_or_incomplete_native_proof_never_builds(self):
        valid={'exitCode':0,'counts':{'tests':150,'pass':150,'fail':0,'skipped':0},'networkDisabled':True,
            'newProviderRequests':0,'syntheticExtractionOnly':True,'abortedReason':None,'image':'base'}
        cases=[('exitCode',1),('counts',{'tests':150,'pass':149,'fail':0,'skipped':1}),
            ('networkDisabled',False),('newProviderRequests',1),('syntheticExtractionOnly',False),
            ('abortedReason','viewer_started'),('image','wrong')]
        for key,value in cases:
            self.ns['NATIVE']=Mock(read_text=Mock(return_value=json.dumps({**valid,key:value})))
            with self.assertRaisesRegex(RuntimeError,'native_proof_mismatch'):
                self.ns['stage']()
            self.gw.run.assert_not_called();self.assertFalse((self.root/'context').exists())

    def test_exact_two_modules_and_unmodified_idle_supervisor(self):
        source=DEPLOY.read_text()
        self.assertIn("FILES=('index.js','passive-lid-capture.js')",source)
        self.assertIn('deploy-scoped-passive-dormant-20260912.py',source)
        for forbidden in ('op.deploy=','op.run=','op.recover=','op.recovery_idle=',
            'UPDATE public.','DELETE FROM','os.kill(','cancellation_sql('):
            self.assertNotIn(forbidden,source)


class NativeIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.health={'ok':True,'activeSessions':0,'activeViewerSubtitleOperations':0,'pendingViewerSubtitleOperations':0}
        self.os=types.SimpleNamespace(umask=Mock(),getloadavg=Mock(return_value=(0,0,0)),cpu_count=lambda:16)
        self.paths=types.SimpleNamespace(Path=lambda name:Mock(read_text=lambda:'MemAvailable: 4194304 kB')
            if name=='/proc/meminfo' else pathlib.Path(name))
        self.gw=types.SimpleNamespace(health=Mock(side_effect=lambda:self.health),run=Mock(),
            inspect=lambda:{'Id':'production','Image':'exact-image'},sha=lambda data:hashlib.sha256(data).hexdigest(),
            private_write=Mock(side_effect=lambda path,value:path.write_text(json.dumps(value))))
        self.live=types.SimpleNamespace(verify=Mock(),gw=self.gw,require=require)
        spec=types.SimpleNamespace(name='fake',loader=types.SimpleNamespace(exec_module=lambda module:None))
        self.popen=Mock(side_effect=self.fake_process)
        self.ns={'ROOT':self.root,'PARENT':'unused','os':self.os,'pathlib':self.paths,
            'importlib':types.SimpleNamespace(util=types.SimpleNamespace(spec_from_file_location=lambda *args:spec,
                module_from_spec=lambda spec:self.live)),'sys':types.SimpleNamespace(modules={}),
            'subprocess':types.SimpleNamespace(Popen=self.popen,run=Mock()),'json':json,'re':re,'tarfile':tarfile,
            'time':types.SimpleNamespace(monotonic=lambda:1,sleep=Mock()),
            'TESTS':('synthetic.test.js',),'FILES':{'tests/synthetic.test.js','public/webengine/media/s_h264_ac3.mkv'}}
        functions(NATIVE,self.ns)

    def fake_process(self,args,stdout,stderr):
        stdout.write('# tests 150\n# pass 150\n# fail 0\n# skipped 0\n')
        return types.SimpleNamespace(poll=lambda:0,wait=lambda **kwargs:0)

    def archive(self,extra=None):
        self.binary=b'\x1aE\xdf\xa3\x00\r\n\xff\r\n'
        entries={'tests/synthetic.test.js':b'// test\r\n','public/webengine/media/s_h264_ac3.mkv':self.binary}
        if extra:entries.update(extra)
        with tarfile.open(self.root/'source.tar','w') as archive:
            for name,data in entries.items():
                info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))

    def test_cpu_or_viewer_guard_prevents_any_test_container(self):
        self.os.getloadavg.return_value=(12,0,0)
        with self.assertRaisesRegex(RuntimeError,'native_cpu_pressure'):self.ns['main']()
        self.assertFalse((self.root/'payload').exists());self.popen.assert_not_called();self.gw.run.assert_not_called()
        self.os.getloadavg.return_value=(0,0,0);self.health['activeSessions']=1
        with self.assertRaisesRegex(RuntimeError,'native_viewer_active_or_unknown'):self.ns['main']()
        self.popen.assert_not_called();self.gw.run.assert_not_called()

    def test_binary_fixture_intact_and_native_test_is_networkless_and_bounded(self):
        self.archive()
        with contextlib.redirect_stdout(io.StringIO()):self.ns['main']()
        self.assertEqual((self.root/'payload/public/webengine/media/s_h264_ac3.mkv').read_bytes(),self.binary)
        self.assertEqual((self.root/'payload/tests/synthetic.test.js').read_bytes(),b'// test\n')
        args=self.popen.call_args.args[0]
        for name,value in [('--network','none'),('--cpus','.5'),('--memory','512m'),('--pids-limit','64'),
            ('--tmpfs','/tmp:rw,nosuid,nodev,size=64m')]:self.assertEqual(args[args.index(name)+1],value)
        self.assertIn('--read-only',args);self.assertIn('exact-image',args)
        self.assertIn('NORVA_CAPTURE_REAL_FFMPEG=1',args);self.assertIn('NORVA_MKV_EARLY_PROBE_NATIVE=1',args)
        self.assertTrue(json.loads((self.root/'native-proof.json').read_text())['syntheticExtractionOnly'])

    def test_viewer_arrival_stops_only_owned_synthetic_container(self):
        self.archive();checks=iter([self.health,{**self.health,'activeSessions':1}])
        self.gw.health.side_effect=lambda:next(checks)
        process=types.SimpleNamespace(poll=lambda:None,wait=lambda **kwargs:143)
        self.popen.side_effect=lambda *args,**kwargs:process
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError,'native_tests_failed'):self.ns['main']()
        self.ns['subprocess'].run.assert_called_once_with(
            ['docker','stop','--time','1','norva-passive-qos-diagnostics-native-20260913-r2'],
            capture_output=True,timeout=10)
        proof=json.loads((self.root/'native-proof.json').read_text())
        self.assertEqual(proof['abortedReason'],'viewer_started_or_health_unavailable')
        self.assertNotEqual(proof['exitCode'],0)

    def test_unlisted_archive_member_cannot_run(self):
        self.archive({'../../escape':b'unsafe'})
        with self.assertRaisesRegex(RuntimeError,'native_archive_scope'):self.ns['main']()
        self.popen.assert_not_called();self.gw.private_write.assert_not_called()


if __name__=='__main__':unittest.main()
