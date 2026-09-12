"""Offline executable tests; no imports of server operators or provider I/O."""
import ast
import copy
import json
import pathlib
import re
import tempfile
import types
import unittest

HERE=pathlib.Path(__file__).parent
SOURCE=(HERE/'resume-enrichment-maintenance-20260912.py').read_text(encoding='utf8')
TREE=ast.parse(SOURCE)
CREATED={'2026-09-12T00:30:04.243216+00:00','2026-09-12T00:30:04.315305+00:00'}


def require(value,code):
    if not value:raise RuntimeError(code)


def functions(names,ns):
    selected=[n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(body=selected,type_ignores=[]),'maintenance-functions','exec'),ns)
    return ns


def jobs():
    return [{'job_id':'00000000-0000-4000-8000-00000000000'+str(i),'created_at':created,
        'kind':'transcript','status':'processing','identity_hash':str(i)*32,'row_hash':str(i)*32,
        'vtt_hash':'a'*32 if i==1 else None,'vtt_chars':35000 if i==1 else None,
        'segments':457 if i==1 else None,'audio_sec':600 if i==1 else None,'source_lang':'en'}
        for i,created in enumerate(sorted(CREATED),1)]


def baseline_health():
    return {'ok':True,'transcribeBusy':True,'transcribeQueueDepth':1,
        'whisperInferenceActive':1,'backgroundWhisperInferenceActive':1,
        'activeSessions':0,'activeStrictLidBrokers':0,'backgroundCpuProcessCount':0,
        'rawPumpCount':0,'viewerStartupReservations':0,'viewerSessionStartupAdmissions':0,
        'ocrQueueDepth':0,'translateQueueDepth':0,'languageWavExtraction':{'active':0},
        'ocrBusy':False,'translateBusy':False,'lidBenchmarkBusy':False,'viewerPlaybackActiveLocally':False}


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.ns=functions({'approved_subset','guard_health'},
            {'require':require,'OBSERVED_CREATED':CREATED,'copy':copy})
        original=ast.parse((HERE/'deploy-strict-lid-adaptive-evidence-20260910.py').read_text(encoding='utf8'))
        nodes=[n for n in original.body if isinstance(n,ast.Assign) and
            any(isinstance(t,ast.Name) and t.id in ('IDLE_COUNTS','IDLE_FLAGS') for t in n.targets)
            or isinstance(n,ast.FunctionDef) and n.name=='assert_idle']
        guard={'require':require};exec(compile(ast.Module(body=nodes,type_ignores=[]),'original-idle','exec'),guard)
        self.ns['gw']=types.SimpleNamespace(assert_idle=guard['assert_idle'])

    def test_only_two_observed_identities_can_be_approved(self):
        rows=jobs();before=copy.deepcopy(rows)
        self.assertEqual(self.ns['approved_subset'](rows,rows),rows)
        self.assertEqual(rows,before)
        for mutation in ('identity_hash','kind','job_id'):
            changed=copy.deepcopy(rows);changed[0][mutation]='other'
            with self.assertRaises(RuntimeError):self.ns['approved_subset'](changed,rows)
        changed=copy.deepcopy(rows);changed[0]['created_at']='another-day'
        with self.assertRaisesRegex(RuntimeError,'approved_subtitle_scope_changed'):
            self.ns['approved_subset'](changed,changed)

    def test_new_or_missing_processing_job_refuses_interruption(self):
        rows=jobs()
        for changed in (rows[:1],rows+[dict(rows[0],job_id='another')]):
            with self.assertRaisesRegex(RuntimeError,'unapproved_subtitle_job_present'):
                self.ns['approved_subset'](changed,rows)

    def test_naturally_completed_job_is_not_interrupted(self):
        rows=jobs();after=copy.deepcopy(rows);after[0]['status']='ready'
        self.assertEqual(self.ns['approved_subset'](after,rows),after[1:])

    def test_only_matching_background_subtitle_counters_are_waived(self):
        health=baseline_health();before=copy.deepcopy(health)
        self.ns['guard_health'](health,jobs());self.assertEqual(health,before)
        for key,value in (('transcribeQueueDepth',2),('transcribeQueueDepth',0),
            ('whisperInferenceActive',2),('backgroundWhisperInferenceActive',0),
            ('transcribeBusy',False),('transcribeBusy',1),('whisperInferenceActive',True)):
            with self.assertRaises(RuntimeError):self.ns['guard_health']({**health,key:value},jobs())

    def test_busy_drain_with_one_deferred_job_is_not_counted_as_two_jobs(self):
        health={**baseline_health(),'whisperInferenceActive':0,'backgroundWhisperInferenceActive':0}
        self.ns['guard_health'](health,jobs()[1:])
        with self.assertRaises(RuntimeError):self.ns['guard_health'](health,[])

    def test_all_original_viewer_acquisition_cpu_and_other_job_guards_remain(self):
        health=baseline_health()
        for key in ('activeSessions','activeStrictLidBrokers','backgroundCpuProcessCount','rawPumpCount',
            'viewerStartupReservations','viewerSessionStartupAdmissions','ocrQueueDepth','translateQueueDepth'):
            with self.assertRaises(RuntimeError):self.ns['guard_health']({**health,key:1},jobs())
            missing=copy.deepcopy(health);missing.pop(key)
            with self.assertRaises(RuntimeError):self.ns['guard_health'](missing,jobs())
        for key in ('ocrBusy','translateBusy','lidBenchmarkBusy','viewerPlaybackActiveLocally'):
            with self.assertRaises(RuntimeError):self.ns['guard_health']({**health,key:True},jobs())
        with self.assertRaises(RuntimeError):
            self.ns['guard_health']({**health,'languageWavExtraction':{'active':1}},jobs())

    def test_db_cancellation_locks_exact_processing_snapshot_and_never_erases_vtt(self):
        ns=functions({'cancellation_sql'},{'require':require,'re':re,'REASON':'maintenance',
            'r':types.SimpleNamespace(pilot=types.SimpleNamespace(UUID=re.compile(r'[a-f0-9-]{36}')),
                fleet=types.SimpleNamespace(literal=lambda s:"'"+s.replace("'","''")+"'"))})
        rows=jobs();query=ns['cancellation_sql'](rows)
        self.assertTrue(query.startswith('BEGIN;'));self.assertTrue(query.endswith('COMMIT;'))
        self.assertEqual(query.count('UPDATE public.catalog_generated_subtitles'),2)
        self.assertEqual(query.count('FOR UPDATE'),2)
        self.assertIn('md5(to_jsonb(s)::text)',query)
        self.assertEqual(query.count("AND status='processing'"),4)
        for term in ('vtt=','vtt =','segments=','audio_sec=','job_id=NULL','DELETE','TRUNCATE'):
            self.assertNotIn(term,query)
        rows[0]['status']='ready';query=ns['cancellation_sql'](rows)
        self.assertNotIn(rows[0]['job_id'],query)
        self.assertEqual(query.count('UPDATE public.catalog_generated_subtitles'),1)

    def test_coordinator_must_be_stopped_before_database_mutation(self):
        calls=[]
        ns=functions({'cancel_stopped'},{'require':require,
            'gw':types.SimpleNamespace(inspect=lambda _:{'State':{'Running':True}}),
            'sql':lambda *_,**__:calls.append('write')})
        with self.assertRaisesRegex(RuntimeError,'subtitle_coordinator_still_running'):
            ns['cancel_stopped']({'gatewayId':'approved'})
        self.assertEqual(calls,[])

    def test_failed_candidate_restores_original_and_does_not_requeue_jobs(self):
        events=[];approval={'planSha256':'digest','operatorSha256':'digest','previousClosureSha256':'digest','gatewayId':'old','jobs':jobs()}
        original={'Id':'old'};plan={'gatewayBefore':original,'parentPlan':{},'imageIdentity':'image'}
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            (root/'plan.private.json').write_text('private');(root/'closed.private.json').write_text('private')
            def inspect(name):return original if name=='gateway' else {'Id':name}
            def run(args):events.append(('docker',args[1],args[-1]))
            def cancel(_):events.append('cancel');raise RuntimeError('injected_post_stop_failure')
            ns=functions({'replace_gateway'},{'require':require,'ROOT':root,'PREVIOUS':root,
                '__file__':str(root/'plan.private.json'),'pathlib':pathlib,
                'ordinary_replace':lambda *_:events.append('ordinary'),
                'maintenance_idle':lambda _:events.append('guard'),'cancel_stopped':cancel,
                'gw':types.SimpleNamespace(inspect=inspect,image_identity=lambda _:'image',run=run,
                    clone_payload=lambda *_:{},docker_api=lambda *_:{'Id':'new'},assert_clone=lambda *_:None),
                'r':types.SimpleNamespace(saved=lambda _:approval,sha=lambda _:'digest',IMAGE='image',
                    stamp=lambda:'now',save=lambda *_:events.append('intent'),environment=lambda *_:{},
                    d=types.SimpleNamespace(SERVICES=['gateway'],verify_service=lambda *_:None,
                        edge=types.SimpleNamespace(restore=lambda *_:events.append('restore'))))})
            with self.assertRaisesRegex(RuntimeError,'maintenance_gateway_restored'):
                ns['replace_gateway'](plan,True,'before-resume')
            self.assertLess(events.index(('docker','stop','old')),events.index('cancel'))
            self.assertEqual(events[-1],'restore')
            ns['replace_gateway'](plan,False,'completed');self.assertEqual(events[-1],'ordinary')

    def test_scope_deadline_and_proxy_configuration_not_broadened(self):
        self.assertNotIn('UPDATE public.catalog_file_audio_validation_jobs',SOURCE)
        self.assertNotIn('DELETE FROM',SOURCE);self.assertNotIn('PROVIDER_PROXY_',SOURCE)
        self.assertNotIn('expiresEpoch=',SOURCE);self.assertNotIn('alter_crons(',SOURCE)
        self.assertIn("r.ROOT=ROOT;r.pilot.ROOT=ROOT/'pilot';r.__file__=__file__",SOURCE)
        self.assertIn("if not active:return ordinary_replace(plan,active,label)",SOURCE)


if __name__=='__main__':unittest.main()
