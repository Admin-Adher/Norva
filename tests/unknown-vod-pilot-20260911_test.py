"""Offline operator tests; no database, secrets, models or provider network."""
import copy
import hashlib
import importlib.util
import io
import json
import multiprocessing
import pathlib
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

try:
    import fcntl
except ImportError:  # Operator runs on Linux; allow pure logic tests on Windows.
    sys.modules['fcntl'] = types.SimpleNamespace(flock=lambda *a: None, LOCK_EX=2, LOCK_NB=4, LOCK_UN=8)
path = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/run-unknown-vod-pilot-20260911.py'
spec = importlib.util.spec_from_file_location('pilot', path)
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)


def row(n=1, provider=1, user=1):
    return {'sample':n,'user_id':f'10000000-0000-4000-8000-{user:012d}',
        'source_id':f'20000000-0000-4000-8000-{provider:012d}',
        'variant_id':f'30000000-0000-4000-8000-{n:012d}',
        'identity_key':f'40000000-0000-4000-8000-{provider:012d}',
        'external_id':str(n),'requested_example':n==1,'has_track_map':False,
        'raw_title':'fixture','category_name':'fixture','preference':n}


def ready():
    return {'audioProbed':True,'tracks':[{'index':1,'lang':'und'}],
        'profile':{'probeSource':'gatewayprobe','probedAt':'2026-09-11T10:00:00Z','container':'mkv',
        'audioTracks':[{'index':1}],'durationSeconds':6000,'fileSizeBytes':123456},
        'activeJobs':0,'starts24h':0,'verified':False,'job':None}


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.patch=patch.object(p,'ROOT',self.root);self.patch.start();self.addCleanup(self.patch.stop)
        epoch=time.time()
        self.plan={'protocol':1,'gatewaySha256':'a'*64,'preparedEpoch':epoch,
            'expiresEpoch':epoch+3600,'rows':[row()]}
        p.save(self.root/'plan.private.json',self.plan,True)
        self.state={'planSha256':hashlib.sha256((self.root/'plan.private.json').read_bytes()).hexdigest(),
            'rows':{'1':{'state':'planned','probeAttempts':0}},'updatedAt':p.now()}
        for obj,name,value in [(p.lib,'require_release',None),(p,'controls',True)]:
            ctx=patch.object(obj,name,return_value=value);ctx.start();self.addCleanup(ctx.stop)

    def test_selection_caps_deduplicates_and_balances_providers(self):
        rows=[row(n,1+n%5,1+n%3) for n in range(1,501)]
        rows.extend(copy.deepcopy(rows[:50]))
        chosen=p.choose(rows)
        self.assertEqual(len(chosen),100)
        self.assertEqual(len({(r['identity_key'],r['external_id']) for r in chosen}),100)
        self.assertEqual(chosen[0]['sample'],1)
        counts=[sum(r['identity_key']==f'40000000-0000-4000-8000-{n:012d}' for r in chosen) for n in range(1,6)]
        self.assertEqual(counts,[20]*5)

    def test_plan_rejects_over_budget_duplicates_bad_owner_and_long_lifetime(self):
        for change in ('limit','duplicate','owner','lifetime'):
            bad=copy.deepcopy(self.plan)
            if change=='limit':bad['rows']=[row(n) for n in range(1,102)]
            if change=='duplicate':bad['rows'].append({**row(2),'external_id':'1'})
            if change=='owner':bad['rows'][0]['user_id']='not-a-uuid'
            if change=='lifetime':bad['expiresEpoch']=bad['preparedEpoch']+p.MAX_SECONDS+1
            with self.assertRaises(RuntimeError):p.validate(bad)

    def test_pool_includes_absent_profiles_but_protects_old_jobs(self):
        sql=p.candidate_sql()
        self.assertIn('LEFT JOIN public.catalog_file_tracks',sql)
        self.assertNotIn('codec_profile IS NOT NULL',sql)
        self.assertIn('NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs',sql)
        self.assertIn('h.active_generation_id=v.generation_id',sql)
        self.assertIn('admin_internal_accounts',sql)

    def test_empty_placeholder_is_not_an_audio_inventory(self):
        self.assertFalse(p.profile_ready({'profile':{},'tracks':None,'audioProbed':False}))
        self.assertTrue(p.profile_ready(ready()))
        bad=ready();bad['tracks'][0]['index']=9
        self.assertFalse(p.profile_ready(bad))

    def test_exact_demuxer_families_keep_their_original_fingerprint(self):
        for container in ('movmp4m4a3gp3g2mj2','webm','mpeg','mpegts'):
            value=ready();value['profile']['container']=container
            before=copy.deepcopy(value)
            self.assertTrue(p.profile_ready(value))
            self.assertEqual(value,before)
        for container in ('hls','dash','unknown','mp4hls','mpegtslive'):
            value=ready();value['profile']['container']=container
            self.assertFalse(p.profile_ready(value))

    def test_reconcile_successful_mp4_inventory_never_repeats_network(self):
        value=ready();value['profile']['container']='movmp4m4a3gp3g2mj2'
        self.state['rows']['1'].update(state='probe_insufficient',probeSucceeded=True,probeAttempts=1)
        with patch.object(p,'current',return_value=value),patch.object(p,'header_probe') as probe,\
                patch.object(p,'enqueue',return_value={'jobId':'50000000-0000-4000-8000-000000000001'}) as start:
            p.step(self.plan,self.state)
        probe.assert_not_called();start.assert_called_once()
        self.assertEqual(self.state['rows']['1']['state'],'validating')

    def test_missing_inventory_gets_only_one_header_attempt(self):
        value={'profile':{},'tracks':None,'audioProbed':False,'activeJobs':0,'starts24h':0}
        with patch.object(p,'current',return_value=value),patch.object(p,'header_probe',return_value={
            'persisted':1,'attempted':1,'deferredBeforeIO':False}) as probe,patch.object(p,'enqueue') as start:
            p.step(self.plan,self.state);p.step(self.plan,self.state)
        self.assertEqual(probe.call_count,1);start.assert_not_called()
        self.assertEqual(self.state['rows']['1']['state'],'probe_insufficient')

    def test_busy_before_io_does_not_consume_budget_or_starve_every_tick(self):
        value={'activeJobs':0,'starts24h':0}
        with patch.object(p,'current',return_value=value),patch.object(p,'header_probe',return_value={
            'persisted':0,'attempted':0,'deferredBeforeIO':True}) as probe:
            p.step(self.plan,self.state);p.step(self.plan,self.state)
        self.assertEqual(probe.call_count,1)
        self.assertEqual(self.state['rows']['1']['probeAttempts'],0)
        self.assertEqual(self.state['rows']['1']['state'],'planned')

    def test_known_container_tracks_are_not_called_speech_verified(self):
        value=ready();value['tracks'][0]['lang']='fr'
        self.state['rows']['1'].update(state='probed',probeAttempts=1)
        with patch.object(p,'current',return_value=value),patch.object(p,'enqueue') as start:
            p.step(self.plan,self.state)
        start.assert_not_called()
        self.assertEqual(self.state['rows']['1']['state'],'identified_from_tracks')
        self.assertIsNone(p.summary(self.plan,self.state)['accuracy'])

    def test_normal_job_is_started_once_then_verified_from_database(self):
        value=ready()
        self.state['rows']['1'].update(state='probed',probeAttempts=1)
        with patch.object(p,'current',return_value=value),patch.object(p,'enqueue',return_value={
            'jobId':'50000000-0000-4000-8000-000000000001'}) as start:
            p.step(self.plan,self.state)
            value.update(verified=True,job={'owned':True,'state':'verified','verified':True})
            p.step(self.plan,self.state)
        self.assertEqual(start.call_count,1)
        self.assertEqual(self.state['rows']['1']['state'],'verified')

    def test_lost_start_response_is_reconciled_not_replayed(self):
        self.state['rows']['1'].update(state='probed',probeAttempts=1)
        with patch.object(p,'current',return_value=ready()),patch.object(p,'enqueue',side_effect=TimeoutError) as start:
            p.step(self.plan,self.state);p.step(self.plan,self.state)
        self.assertEqual(start.call_count,1)
        self.assertEqual(self.state['rows']['1']['state'],'uncertain_requires_review')

    def test_existing_external_or_quarantined_jobs_are_untouched(self):
        for owned in (False,True):
            self.state['rows']['1']={'state':'planned','probeAttempts':0}
            value=ready();value['job']={'state':'failed','quarantined':True,'owned':owned}
            with patch.object(p,'current',return_value=value),patch.object(p,'enqueue') as start,patch.object(p,'header_probe') as probe:
                p.step(self.plan,self.state)
            start.assert_not_called();probe.assert_not_called()
            self.assertEqual(self.state['rows']['1']['state'],'external_job_protected')

    def test_automatic_admission_does_not_apply_the_obsolete_manual_quota(self):
        self.state['rows']['1'].update(state='probed',probeAttempts=1)
        for quota in ({'activeJobs':2,'starts24h':0},{'activeJobs':0,'starts24h':20}):
            self.state['rows']['1'].update(state='probed')
            with patch.object(p,'current',return_value={**ready(),**quota}),patch.object(p,'header_probe') as probe,\
                    patch.object(p,'enqueue',return_value={'jobId':'50000000-0000-4000-8000-000000000001'}) as start:
                p.step(self.plan,self.state)
            probe.assert_not_called();start.assert_called_once()
            self.assertEqual(self.state['rows']['1']['state'],'validating')

    def test_server_automatic_queue_limit_defers_without_new_header_or_loop(self):
        self.state['rows']['1'].update(state='probed',probeAttempts=1,waitingForQuota=True)
        with patch.object(p,'current',return_value=ready()),patch.object(p,'header_probe') as probe,\
                patch.object(p,'enqueue',return_value={'limited':True,'code':'LANGUAGE_AUTOMATIC_QUEUE_FULL'}) as start:
            p.step(self.plan,self.state);p.step(self.plan,self.state)
        probe.assert_not_called();start.assert_called_once()
        receipt=self.state['rows']['1']
        self.assertEqual(receipt['state'],'probed')
        self.assertNotIn('startIntentAt',receipt)
        self.assertNotIn('waitingForQuota',receipt)
        self.assertGreater(receipt['nextEligibleEpoch'],time.time())

    def test_disabled_controls_stop_before_read_or_write(self):
        with patch.object(p,'controls',return_value=False),patch.object(p,'current') as read:
            self.assertFalse(p.step(self.plan,self.state))
        read.assert_not_called()

    def test_selection_and_audit_receipt_cannot_be_silently_overwritten(self):
        with self.assertRaises(FileExistsError):p.save(self.root/'plan.private.json',{},True)
        self.state['planSha256']='b'*64
        with self.assertRaises(RuntimeError):p.step(self.plan,self.state)

    def test_partial_or_changed_shared_binding_requires_fresh_header(self):
        value=ready();value['observedFingerprint']='b'*64
        with patch.object(p.lib,'fingerprint',return_value='a'*64):
            self.assertFalse(p.profile_ready(value))

    def test_future_cache_retry_defers_without_probe(self):
        value=ready();value['retryAt']='2099-01-01T00:00:00Z'
        with patch.object(p,'current',return_value=value),patch.object(p,'header_probe') as probe:
            p.step(self.plan,self.state)
        probe.assert_not_called()
        self.assertEqual(self.state['rows']['1']['state'],'planned')

    def test_existing_provider_circuit_defers_without_consuming_file_attempt(self):
        value=ready();value['probeCircuitRetryAt']='2099-01-01T00:00:00Z'
        with patch.object(p,'current',return_value=value),patch.object(p,'header_probe') as probe,patch.object(p,'enqueue') as start:
            p.step(self.plan,self.state)
        probe.assert_not_called();start.assert_not_called()
        self.assertEqual(self.state['rows']['1']['probeAttempts'],0)
        self.assertGreater(self.state['providerCooldowns'][row()['identity_key']],time.time())

    def test_three_initial_failures_stop_expansion(self):
        self.state['rows'].update({str(n):{'state':'probe_failed_or_uncertain'} for n in (10,11,12)})
        with patch.object(p,'current') as read:
            self.assertFalse(p.step(self.plan,self.state))
        read.assert_not_called()
        self.assertEqual(self.state['stoppedReason'],'initial_header_probes_failed')

    def test_viewer_deferral_cools_the_whole_user_before_io(self):
        with patch.object(p,'current',return_value={}),patch.object(p,'header_probe',return_value={
                'persisted':0,'attempted':0,'deferredBeforeIO':True,'reason':'live-session'}) as probe:
            # A visible source with an empty profile still exists.
            with patch.object(p,'current',return_value={'profile':{}}):
                p.step(self.plan,self.state)
            self.state['rows']['1'].pop('nextEligibleEpoch')
            p.step(self.plan,self.state)
        self.assertEqual(probe.call_count,1)
        self.assertGreater(self.state['userCooldowns'][row()['user_id']],time.time())
        self.assertEqual(self.state['rows']['1']['probeAttempts'],0)

    def test_probe_failure_retains_only_bounded_diagnostic(self):
        with patch.object(p,'current',return_value={'profile':{}}),patch.object(p,'header_probe',
                side_effect=p.ProbeFailure('incomplete_codec_profile',502)):
            p.step(self.plan,self.state)
        self.assertEqual(self.state['rows']['1']['errorCode'],'incomplete_codec_profile')
        self.assertEqual(self.state['rows']['1']['httpStatus'],502)
        self.assertEqual(p.summary(self.plan,self.state)['consumedFileProbeSlots'],1)

    def test_background_child_waits_for_parent_launch_lock(self):
        with patch.object(p.fcntl,'flock') as flock:
            with p.lock(wait=True):pass
        self.assertEqual(flock.call_args_list[0].args[1],p.fcntl.LOCK_EX)

    def test_reviewed_runtime_receipt_is_bound_to_immutable_plan_and_deadline(self):
        approval={'protocol':1,'planSha256':self.state['planSha256'],
            'originalGatewaySha256':'a'*64,'gatewaySha256':'b'*64,'expiresEpoch':self.plan['expiresEpoch']}
        self.assertEqual(p.expected_runtime(self.plan,self.state),'a'*64)
        p.save(self.root/'runtime.private.json',approval)
        self.assertEqual(p.expected_runtime(self.plan,self.state),'b'*64)
        for key,value in [('planSha256','c'*64),('originalGatewaySha256','c'*64),
                ('expiresEpoch',self.plan['expiresEpoch']+1),('gatewaySha256','live-auto')]:
            p.save(self.root/'runtime.private.json',{**approval,key:value})
            with self.assertRaises(RuntimeError):p.expected_runtime(self.plan,self.state)

    def test_known_shared_inventory_is_reused_without_reprobe_even_when_multitrack(self):
        value=ready();value['tracks']=[{'index':n,'lang':'en'} for n in range(14)]
        with patch.object(p,'current',return_value=value),patch.object(p,'header_probe') as probe,patch.object(p,'enqueue') as start:
            p.step(self.plan,self.state)
        probe.assert_not_called();start.assert_not_called()
        self.assertEqual(self.state['rows']['1']['state'],'identified_from_tracks')
        self.assertEqual(self.state['rows']['1']['probeAttempts'],0)

    def test_reconciliation_observes_all_rows_without_reopening_terminal_failures(self):
        for terminal in ('quarantined','validation_failed','probe_failed_or_uncertain','probe_insufficient'):
            self.state['rows']['1'].update(state=terminal,probeAttempts=1,errorCode='protected')
            before=copy.deepcopy(self.state['rows']['1'])
            value=ready();value['verified']=True
            with patch.object(p,'current',return_value=value),patch.object(p,'enqueue') as start,patch.object(p,'header_probe') as probe:
                p.reconcile(self.plan,self.state)
            for key,value in before.items():self.assertEqual(self.state['rows']['1'][key],value)
            start.assert_not_called();probe.assert_not_called()
            self.assertEqual(self.state['rows']['1']['cacheResult'],'verified')

    def test_resume_preserves_plan_budget_attempts_original_receipts_and_old_state(self):
        self.state['rows']['1'].update(state='probe_failed_or_uncertain',probeAttempts=1,errorCode='protected')
        p.save(self.root/'state.private.json',self.state)
        p.save(self.root/'launch.private.json',{'original':True})
        before=(self.root/'plan.private.json').read_bytes()
        with patch.object(p,'process_active',return_value=False),patch.object(p,'current',return_value=ready()),\
                patch.object(p,'spawn_runner',return_value={'pid':123,'startTicks':'42'}) as spawn:
            result=p.resume('b'*64)
        spawn.assert_called_once()
        self.assertTrue(result['resumed'])
        self.assertEqual((self.root/'plan.private.json').read_bytes(),before)
        self.assertEqual(p.private(self.root/'launch.private.json'),{'original':True})
        saved=p.private(self.root/'state.private.json')
        self.assertEqual(saved['rows']['1']['probeAttempts'],1)
        self.assertEqual(saved['rows']['1']['state'],'probe_failed_or_uncertain')
        archive=p.private(next(self.root.glob('resume-*.private.json')))
        self.assertEqual(archive['previousState'],self.state)
        self.assertEqual(archive['approval']['expiresEpoch'],self.plan['expiresEpoch'])

    def test_resume_refuses_live_duplicate_expiry_stopped_guard_or_runtime_mismatch(self):
        p.save(self.root/'state.private.json',self.state)
        for refusal in ('live','expiry','stopped','runtime'):
            with self.subTest(refusal=refusal):
                state=copy.deepcopy(self.state)
                if refusal=='stopped':state['stoppedReason']='initial_header_probes_failed'
                p.save(self.root/'state.private.json',state)
                with patch.object(p,'process_active',return_value=refusal=='live'),\
                        patch.object(p.time,'time',return_value=self.plan['expiresEpoch']+1 if refusal=='expiry' else self.plan['preparedEpoch']+1),\
                        patch.object(p.lib,'require_release',side_effect=RuntimeError('gateway_release_mismatch') if refusal=='runtime' else None),\
                        patch.object(p,'reconcile') as read,patch.object(p,'spawn_runner') as spawn:
                    with self.assertRaises(RuntimeError):p.resume('b'*64)
                read.assert_not_called();spawn.assert_not_called()
        self.assertFalse((self.root/'runtime.private.json').exists())

    def test_transient_failure_is_recorded_and_retried_without_resetting_intentions(self):
        self.state['rows']['1'].update(state='start_intent',probeAttempts=1,startIntentAt=p.now())
        p.save(self.root/'state.private.json',self.state)
        slept=[]
        def sleep(delay):
            saved=p.private(self.root/'state.private.json');slept.append(saved)
            self.assertEqual(saved['lastErrorCode'],'pilot_dependency_unavailable')
            self.assertEqual(saved['rows']['1']['state'],'start_intent')
        def step(plan,state):
            if not slept:raise TimeoutError('private-provider-url-must-not-be-logged')
            state['rows']['1']['state']='uncertain_requires_review'
        with patch.object(p,'step',side_effect=step),patch.object(p.time,'sleep',side_effect=sleep),patch('sys.stdout',new_callable=io.StringIO) as log:
            p.operate()
        self.assertEqual(len(slept),1)
        self.assertNotIn('private-provider-url',log.getvalue())
        saved=p.private(self.root/'state.private.json')
        self.assertEqual(saved['rows']['1']['probeAttempts'],1)
        self.assertEqual(saved['consecutiveFailures'],0)
        self.assertEqual(saved['runtimeStatus'],'finished')

    def test_unreviewed_runtime_mismatch_pauses_without_network_or_adopting_hash(self):
        p.save(self.root/'state.private.json',self.state)
        with patch.object(p.lib,'require_release',side_effect=RuntimeError('gateway_release_mismatch')),\
                patch.object(p,'current') as read,patch.object(p,'header_probe') as probe,patch('sys.stdout',new_callable=io.StringIO):
            p.operate(once=True)
        read.assert_not_called();probe.assert_not_called()
        saved=p.private(self.root/'state.private.json')
        self.assertEqual(saved['runtimeStatus'],'paused_runtime')
        self.assertEqual(saved['lastErrorCode'],'gateway_release_mismatch')
        self.assertIsNotNone(saved['heartbeatAt'])
        self.assertFalse((self.root/'runtime.private.json').exists())

    def test_controls_pause_and_expiry_are_durable_and_never_extend_deadline(self):
        p.save(self.root/'state.private.json',self.state)
        with patch.object(p,'controls',return_value=False),patch('sys.stdout',new_callable=io.StringIO):
            p.operate(once=True)
        saved=p.private(self.root/'state.private.json')
        self.assertEqual(saved['runtimeStatus'],'paused_controls')
        self.assertIsNotNone(saved['heartbeatAt'])
        with patch.object(p.time,'time',return_value=self.plan['expiresEpoch']+1),\
                patch.object(p,'step') as step,patch('sys.stdout',new_callable=io.StringIO):
            p.operate()
        step.assert_not_called()
        self.assertEqual(p.private(self.root/'state.private.json')['stoppedReason'],'original_pilot_deadline_reached')

    def test_unknown_exception_is_closed_and_does_not_restart_a_terminal_guard(self):
        p.save(self.root/'state.private.json',self.state)
        with patch.object(p,'step',side_effect=ValueError('secret must stay private')) as step,\
                patch('sys.stdout',new_callable=io.StringIO) as log:
            p.operate();p.operate()
        self.assertEqual(step.call_count,1)
        self.assertNotIn('secret must stay private',log.getvalue())
        self.assertEqual(p.private(self.root/'state.private.json')['stoppedReason'],'pilot_local_or_contract_error')

    @unittest.skipUnless(sys.platform=='linux','real advisory locks require the production Linux platform')
    def test_linux_cross_process_lock_refuses_a_second_resume(self):
        context=multiprocessing.get_context('fork')
        ready_event=context.Event();release_event=context.Event()
        def holder():
            with p.lock(wait=True):
                ready_event.set();release_event.wait(5)
        child=context.Process(target=holder);child.start()
        try:
            self.assertTrue(ready_event.wait(3))
            with patch.object(p,'spawn_runner') as spawn,patch.object(p,'current') as read:
                with self.assertRaises(BlockingIOError):p.resume('b'*64)
            read.assert_not_called();spawn.assert_not_called()
        finally:
            release_event.set();child.join(5)
            if child.is_alive():child.terminate();child.join(2)
        self.assertEqual(child.exitcode,0)


if __name__=='__main__':
    unittest.main()
