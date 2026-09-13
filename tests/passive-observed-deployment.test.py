"""Offline checks of the dormant two-module release's actual functions."""
import ast
import copy
import json
import pathlib
import re
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE=pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-passive-observed-grant-20260913.py'
def require(value,code):
    if not value:raise RuntimeError(code)

class ObservedGrantReleaseTests(unittest.TestCase):
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
            'live':types.SimpleNamespace(verify=Mock(),live=types.SimpleNamespace(source_snapshot=lambda:self.plan['after'])),
            'op':types.SimpleNamespace(SERVICE='gateway',saved=lambda name:{'candidateContainer':'new'})}
        functions=[node for node in ast.parse(SOURCE.read_text()).body if isinstance(node,ast.FunctionDef)]
        exec(compile(ast.Module(body=functions,type_ignores=[]),str(SOURCE),'exec'),self.ns)

    def test_owned_image_hash_and_runtime_are_checked(self):
        self.ns['verify_gateway'](self.plan,True)
        self.gw.assert_clone.assert_called_once_with(self.plan['original'],self.current,'candidate')
        self.gw.assert_container_image.assert_called_once_with(self.current,'new-image')
        self.gw.assert_runtime.assert_called_once_with(self.health,{})

    def test_foreign_container_or_source_drift_is_rejected(self):
        self.current['Id']='foreign'
        with self.assertRaisesRegex(RuntimeError,'gateway_container_not_owned'):
            self.ns['verify_gateway'](self.plan,True)
        self.current['Id']='new';self.ns['live'].live.source_snapshot=lambda:{'index.js':'drift'}
        with self.assertRaisesRegex(RuntimeError,'gateway_source_changed'):
            self.ns['verify_gateway'](self.plan,True)

    def test_no_pilot_or_collection_activation_in_dormant_release(self):
        for key,value in [('mode','pilot'),('files',1),('passiveSources',1)]:
            health=copy.deepcopy(self.health);self.health['languageEnrichmentPilot'][key]=value
            with self.assertRaisesRegex(RuntimeError,'dormant_admission_changed'):
                self.ns['verify_gateway'](self.plan,True)
            self.health=health

    def test_failed_or_wrong_native_proof_cannot_build(self):
        valid={'exitCode':0,'counts':{'tests':40,'pass':40,'fail':0,'skipped':0},'networkDisabled':True,
            'newProviderRequests':0,'syntheticAudioOnly':True,'abortedReason':None,'image':'base'}
        for key,value in [('exitCode',1),('counts',{}),('networkDisabled',False),('newProviderRequests',1),
            ('syntheticAudioOnly',False),('abortedReason','viewer_started'),('image','wrong')]:
            self.ns['NATIVE']=Mock(read_text=Mock(return_value=json.dumps({**valid,key:value})))
            with self.assertRaisesRegex(RuntimeError,'native_proof_mismatch'):
                self.ns['stage']()
            self.gw.run.assert_not_called();self.assertFalse((self.root/'context').exists())

    def test_uses_unmodified_idle_recovery_without_subtitle_stop_override(self):
        source=SOURCE.read_text()
        self.assertIn("FILES=('index.js','enrichment-pilot-admission.js')",source)
        self.assertIn('deploy-scoped-passive-dormant-20260912.py',source)
        for forbidden in ('op.deploy=','op.run=','op.recover=','op.recovery_idle=',
            'UPDATE public.','DELETE FROM','os.kill(','cancellation_sql('):
            self.assertNotIn(forbidden,source)

if __name__=='__main__':unittest.main()
