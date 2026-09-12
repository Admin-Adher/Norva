"""Offline executable configuration tests; no production imports or I/O."""
import ast
import copy
import json
import pathlib
import tempfile
import types
import unittest

SOURCE=pathlib.Path(__file__).with_name('deploy-enrichment-pilot20-20260911.py').read_text(encoding='utf8')
tree=ast.parse(SOURCE)


def require(value,code):
    if not value:raise RuntimeError(code)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in
            ('mount_replace','environment','expected_container')]
        self.ns={'copy':copy,'ROOT':pathlib.PurePosixPath('/private/pilot20'),'require':require,
            'SERVICES':('gateway','edge1','edge2','selection')}
        exec(compile(ast.Module(body=selected,type_ignores=[]),'scoped-release-functions','exec'),self.ns)
        self.original={'Config':{'Env':['SECRET=untouched','SELECTION_AUDIO_CONCURRENCY=1']},
            'HostConfig':{'Binds':['/existing/runner:/worker/ops/hetzner/services:ro',
                '/existing/functions:/worker/supabase/functions:ro'],'Memory':1234},
            'Mounts':[{'Type':'bind','Source':'/existing/runner','Destination':'/worker/ops/hetzner/services','RW':False},
                {'Type':'bind','Source':'/existing/functions','Destination':'/worker/supabase/functions','RW':False}]}

    def test_selection_preserves_secret_resources_and_original(self):
        before=copy.deepcopy(self.original)
        plan={'containers':{'selection':self.original},'selectionMounts':{
            '/worker/ops/hetzner/services':'selection-live-runner','/worker/supabase/functions':'selection-live-functions'}}
        result=self.ns['expected_container'](plan,'selection')
        self.assertEqual(self.original,before)
        self.assertIn('SECRET=untouched',result['Config']['Env'])
        self.assertIn('SELECTION_CAPTURE_PIPELINE_ENABLED=0',result['Config']['Env'])
        self.assertIn('SELECTION_AUDIO_CONCURRENCY=1',result['Config']['Env'])
        self.assertEqual(result['HostConfig']['Memory'],1234)
        self.assertTrue(all(not m['RW'] for m in result['Mounts']))
        self.assertEqual(result['Mounts'][0]['Source'],'/private/pilot20/selection-live-runner')

    def test_gateway_adds_only_exact_private_volume_and_approved_env(self):
        before=copy.deepcopy(self.original)
        plan={'containers':{'gateway':self.original},'gatewayEnv':{'LANGUAGE_ENRICHMENT_ACTIVATION_MODE':'pilot'}}
        result=self.ns['expected_container'](plan,'gateway')
        self.assertEqual(self.original,before)
        self.assertEqual(result['Mounts'][-1]['Destination'],'/var/lib/norva-lid-private')
        self.assertEqual(result['Mounts'][-1]['Source'],'/private/pilot20/audio-private')
        self.assertEqual(len(result['Mounts']),len(before['Mounts'])+1)
        self.assertEqual(result['HostConfig']['Memory'],before['HostConfig']['Memory'])

    def test_missing_or_ambiguous_mount_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError,'mount_missing'):
            self.ns['mount_replace'](self.original,pathlib.Path('/new'),'/wrong')
        self.original['HostConfig']['Binds'].append(self.original['HostConfig']['Binds'][0])
        with self.assertRaisesRegex(RuntimeError,'mount_missing'):
            self.ns['mount_replace'](self.original,pathlib.Path('/new'),'/worker/ops/hetzner/services')

    def test_runner_cannot_dispatch_a_general_queue_request(self):
        runner=pathlib.Path(__file__).with_name('run-enrichment-pilot20-20260911.py').read_text(encoding='utf8')
        self.assertIn("json.dumps({'jobIds':ids})",runner)
        self.assertIn('len(ids)<=2',runner)
        self.assertIn("len(p['rows'])==MAX_FILES",runner)
        self.assertIn("MAX_FILES=20",runner)
        self.assertIn("gate.get('files')==MAX_FILES",runner)
        self.assertNotIn('UPDATE public.catalog_file_audio_validation_jobs',runner)
        self.assertNotIn('CREATE OR REPLACE',runner)
        self.assertIn("retry_at<=now()",runner)
        self.assertIn("quarantined_at IS NULL",runner)

    def test_scoped_health_keeps_security_flags_and_uses_real_recent_dispatch(self):
        source=pathlib.Path(__file__).with_name('run-enrichment-pilot20-20260911.py').read_text(encoding='utf8')
        fn=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='scoped_controls')
        flags={'paused':False,'runtime':{'audioEnabled':True,'legacyEnabled':False,'workerHealthy':False}}
        crons=[{'id':1,'active':True},{'id':2,'active':True}]
        ns={'pilot':types.SimpleNamespace(query=lambda _:flags),'time':types.SimpleNamespace(time=lambda:1000),
            'dispatch_healthy_at':999,'release':types.SimpleNamespace(saved=lambda _: {'crons':crons},
                prior=types.SimpleNamespace(crons=lambda:[{**j,'active':False} for j in crons]))}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'scoped-health','exec'),ns)
        self.assertTrue(ns['scoped_controls']())
        ns['dispatch_healthy_at']=900;self.assertFalse(ns['scoped_controls']())
        ns['dispatch_healthy_at']=999;flags['runtime']['legacyEnabled']=True;self.assertFalse(ns['scoped_controls']())
        flags['runtime']['legacyEnabled']=False;flags['paused']=True;self.assertFalse(ns['scoped_controls']())

    def test_cohort_cannot_change_after_first_io_and_closure_waits_for_drain(self):
        self.assertIn("r.get('probeAttempts',0)==0",SOURCE)
        self.assertIn("state.get('dispatches',0)==0",SOURCE)
        self.assertIn("started_cohort_immutable",SOURCE)
        self.assertIn("waiting_for_private_audio_expiry",SOURCE)
        self.assertIn("newLogicPromotedToFleet':False",SOURCE)
        self.assertIn("idle();buffer=gw.health()['languageCaptureBuffer']",SOURCE)

    def test_diagnostic_revision_preserves_immutable_plan_and_all_unrelated_modules(self):
        selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='saved']
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp)
            original={'sourceAfter':{'index.js':'i','unchanged.js':'u','strict-lid-capture-store.js':'old-s',
                'strict-lid-capture-pipeline.js':'old-p','strict-lid-multi-extract.js':'old-m'},
                'gatewayEnv':{'SECRET':'retained'},'gate':{'fileKeys':['same-cohort'],'expiresAt':'unchanged'}}
            before=json.dumps(original);(root/'plan.private.json').write_text(before)
            revision={'originalPlanSha256':'original-hash','sourceAfter':{**original['sourceAfter'],
                'strict-lid-capture-pipeline.js':'new-p','strict-lid-multi-extract.js':'new-m'},
                'image':'new-image','imageIdentity':{'index':'new-digest'}}
            path=root/'diagnostic-revision.private.json';path.write_text(json.dumps(revision))
            ns={'json':json,'ROOT':root,'gw':types.SimpleNamespace(safe_file=lambda r,n:r/n),
                'require':require,'sha':lambda _: 'original-hash','artifact':lambda _:b'original'}
            exec(compile(ast.Module(body=selected,type_ignores=[]),'diagnostic-revision','exec'),ns)
            updated=ns['saved']('plan.private.json')
            self.assertEqual(updated['gatewayEnv'],original['gatewayEnv']);self.assertEqual(updated['gate'],original['gate'])
            self.assertEqual((root/'plan.private.json').read_text(),before)
            revision['sourceAfter']['unchanged.js']='unexpected';path.write_text(json.dumps(revision))
            with self.assertRaisesRegex(RuntimeError,'diagnostic_scope_changed'):ns['saved']('plan.private.json')
            revision['sourceAfter']['unchanged.js']='u';path.write_text(json.dumps(revision))
            duration={**revision,'parentDiagnosticSha256':'original-hash','image':'duration-image',
                'sourceAfter':{**revision['sourceAfter'],'strict-lid-capture-store.js':'new-s'}}
            duration_path=root/'duration-revision.private.json';duration_path.write_text(json.dumps(duration))
            updated=ns['saved']('plan.private.json')
            self.assertEqual(updated['image'],'duration-image');self.assertEqual(updated['gate'],original['gate'])
            duration['sourceAfter']['index.js']='unexpected';duration_path.write_text(json.dumps(duration))
            with self.assertRaisesRegex(RuntimeError,'duration_scope_changed'):ns['saved']('plan.private.json')
            duration['sourceAfter']['index.js']='i';duration_path.write_text(json.dumps(duration))
            sample={**duration,'parentDurationSha256':'original-hash',
                'sourceAfter':{**duration['sourceAfter'],'strict-lid-multi-extract.js':'bounded-samples'}}
            sample_path=root/'sample-bound-revision.private.json';sample_path.write_text(json.dumps(sample))
            self.assertEqual(ns['saved']('plan.private.json')['sourceAfter']['strict-lid-multi-extract.js'],'bounded-samples')
            sample['sourceAfter']['strict-lid-capture-store.js']='unexpected';sample_path.write_text(json.dumps(sample))
            with self.assertRaisesRegex(RuntimeError,'sample_scope_changed'):ns['saved']('plan.private.json')

    def test_diagnostic_deployment_keeps_cohort_and_waits_for_audio_drain(self):
        patch=pathlib.Path(__file__).with_name('deploy-enrichment-pilot20-diagnostics-20260912.py').read_text(encoding='utf8')
        self.assertIn("FILES=('strict-lid-capture-pipeline.js','strict-lid-multi-extract.js')",patch)
        self.assertIn("for k in ('entries','bytes','reservations','computations')",patch)
        self.assertIn('d.idle()',patch)
        self.assertNotIn('write=True',patch)
        self.assertNotIn('urlopen',patch)
        self.assertNotIn("pilot.save",patch)
        self.assertIn('watchdog_pid_reused',SOURCE)
        self.assertIn('watchdog_closing',SOURCE)


if __name__=='__main__':unittest.main()
