"""Offline activation guards: no Docker, production SQL, network or provider I/O."""
import copy, importlib.util, json, pathlib, types, unittest
from unittest import mock

ROOT=pathlib.Path(__file__).resolve().parents[2]
PATH=ROOT/'ops/hetzner/scripts/activate-owned-language-metadata-20260914.py'
spec=importlib.util.spec_from_file_location('activation_under_test',PATH)
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class ActivationTests(unittest.TestCase):
    def proof(self):
        return {'sourceCommit':'a'*40,'operatorSha256':'b'*64,'marker':'owned-language:'+'c'*32,
            'schemaSha256':'d'*64,'flag':{'enabled':False,'xmin':'123','updatedAt':'old','updatedBy':None},
            'flags':{op.FLAG:False,'audio_lid_enabled':True,'enrichment_paused':False}}

    def controller(self):
        plan={'commit':'a'*40,'controls':{'flags':self.proof()['flags']},'crons':[{'id':1,'active':True}]}
        closed={'commit':'a'*40,'updated':True,'cronsRestored':True,'sqlVerified':True}
        base=types.SimpleNamespace(saved=lambda name:closed if name=='closed.private.json' else plan,
            process_alive=mock.Mock(return_value=False),invariant=mock.Mock(),SERVICES=['first','second'],
            verify_edge=mock.Mock(),core=types.SimpleNamespace(base=types.SimpleNamespace(r=types.SimpleNamespace(
                crons=mock.Mock(return_value=plan['crons'])))))
        controller=types.SimpleNamespace(COMMIT='a'*40,base=base,import_health=mock.Mock(),
            gw=types.SimpleNamespace(inspect=lambda name:{'name':name}))
        return controller,plan,closed

    def test_proof_pins_commit_operator_marker_schema_and_original_flag_set(self):
        proof=self.proof();op.validate_proof(proof,'b'*64,'a'*40)
        for key,value in [('sourceCommit','e'*40),('operatorSha256','e'*64),('marker','foreign'),
            ('schemaSha256','bad'),('flag',{'enabled':True,'xmin':'123'}),('flags',{op.FLAG:True}),
            ('flags',{op.FLAG:False,'other':1})]:
            with self.subTest(key=key,value=value),self.assertRaises(RuntimeError):
                op.validate_proof({**proof,key:value},'b'*64,'a'*40)

    def test_transaction_locks_all_flags_but_changes_only_our_bit(self):
        proof=self.proof();before=copy.deepcopy(proof)
        sql=op.transaction(proof,"select '"+'d'*64+"'",True)
        self.assertEqual(proof,before)
        self.assertIn('LOCK TABLE public.admin_feature_flags IN SHARE ROW EXCLUSIVE MODE',sql)
        self.assertIn("SET LOCAL lock_timeout='3s'",sql)
        self.assertIn("SET LOCAL statement_timeout='30s'",sql)
        self.assertIn('jsonb_object_agg(key,enabled)',sql)
        self.assertIn("enabled=false and xmin::text='123'",sql)
        self.assertEqual(sql.count('UPDATE public.admin_feature_flags'),1)
        self.assertEqual(sql.count('WHERE key='+op.literal(op.FLAG)),2)
        self.assertIn('SET enabled=true,updated_at=clock_timestamp()',sql)
        self.assertTrue(sql.endswith('COMMIT;'))
        for denied in ('cron.','DELETE ','INSERT ','quarantined_at','catalog_source','pg_cancel','pg_terminate'):
            self.assertNotIn(denied,sql)

    def test_rehearsal_is_identical_transaction_except_final_rollback(self):
        committed=op.transaction(self.proof(),'select 1',True)
        rehearsed=op.transaction(self.proof(),'select 1',False)
        self.assertEqual(rehearsed,committed.removesuffix('COMMIT;')+'ROLLBACK;')

    def test_owned_rollback_has_marker_xmin_and_complete_flags_compare_and_swap(self):
        proof=self.proof();row={'enabled':True,'xmin':'456','updatedBy':proof['marker']}
        sql=op.transaction(proof,'select 1',True,rollback_row=row)
        self.assertIn("enabled=true and xmin::text='456' and updated_by="+op.literal(proof['marker']),sql)
        self.assertIn('SET enabled=false,updated_at=clock_timestamp()',sql)
        self.assertIn(op.literal(proof['marker']+':rollback'),sql)
        self.assertEqual(proof['flags'][op.FLAG],False)
        for bad in ({**row,'updatedBy':'foreign'},{**row,'enabled':False},{**row,'xmin':"1';delete"}):
            with self.assertRaises(RuntimeError):op.transaction(proof,'select 1',True,rollback_row=bad)

    def test_unknown_response_ownership_requires_our_marker_not_just_enabled(self):
        proof=self.proof()
        self.assertTrue(op.activation_owned({'enabled':True,'updatedBy':proof['marker']},proof))
        self.assertFalse(op.activation_owned({'enabled':True,'updatedBy':'another'},proof))
        self.assertFalse(op.activation_owned({'enabled':False,'updatedBy':proof['marker']},proof))

    def test_both_healthy_replicas_and_original_plan_are_preserved(self):
        controller,plan,_=self.controller();original=copy.deepcopy(plan)
        op.verified_plan(controller,True)
        self.assertEqual(plan,original)
        expected=copy.deepcopy(plan);expected['controls']['flags'][op.FLAG]=True
        controller.base.invariant.assert_called_once_with(expected)
        self.assertEqual(controller.base.verify_edge.call_args_list,[mock.call(plan,'first',True),mock.call(plan,'second',True)])
        self.assertEqual(controller.import_health.call_count,2)

    def test_unfinished_rolled_back_or_incomplete_release_cannot_enable(self):
        for key,value in [('commit','other'),('updated',False),('cronsRestored',False),('sqlVerified',False)]:
            controller,_,closed=self.controller();closed[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'successful_edge_rollout'):
                op.verified_plan(controller,False)
            controller.base.invariant.assert_not_called()

    def test_live_guard_or_cron_drift_blocks_activation(self):
        controller,_,_=self.controller();controller.base.process_alive.return_value=True
        with self.assertRaisesRegex(RuntimeError,'rollout_still_active'):op.verified_plan(controller,False)
        controller.base.process_alive.return_value=False
        controller.base.core.base.r.crons.return_value=[]
        with self.assertRaisesRegex(RuntimeError,'crons_not_restored'):op.verified_plan(controller,False)
        controller.base.verify_edge.assert_not_called()

    def test_second_replica_failure_is_not_silently_ignored(self):
        controller,_,_=self.controller()
        controller.base.verify_edge.side_effect=[None,RuntimeError('second_failed')]
        with self.assertRaisesRegex(RuntimeError,'second_failed'):op.verified_plan(controller,False)
        self.assertEqual(controller.import_health.call_count,1)

    def test_schema_fingerprint_includes_permissions_and_membership_view(self):
        query=op.schema_query(types.SimpleNamespace(EXTRA_SIGNATURES=['owned(text)']),types.SimpleNamespace(SIGNATURES=['private(uuid)']))
        for text in ('pg_get_functiondef','proowner','proacl','proconfig','relrowsecurity','relforcerowsecurity',
            'pg_get_viewdef','pg_get_constraintdef','pg_policy','cloud_catalog_owned_audio_declarations','feature_flag(text)'):
            self.assertIn(text,query)
        self.assertNotIn('UPDATE ',query)

    def test_raw_failures_and_short_schema_fingerprints_fail_closed(self):
        for value in ('','[]','error','d'*63):
            with self.assertRaisesRegex(RuntimeError,'schema_fingerprint_missing'):
                op.fingerprint(types.SimpleNamespace(query=lambda _:value),'select 1')
        self.assertEqual(op.literal("owner's marker"),"'owner''s marker'")

    def test_live_ui_checks_canonical_page_and_exact_asset_with_identified_user_agent(self):
        asset=b'public reviewed language utility'
        page=('<script src="'+op.UI_PATH+'"></script>').encode()
        calls=[]
        def open_url(request,**kwargs):
            calls.append(request)
            response=types.SimpleNamespace(status=200,url=request.full_url,
                read=lambda limit:page if request.full_url=='https://norva.tv/app' else asset)
            context=mock.MagicMock();context.__enter__.return_value=response;return context
        with mock.patch.object(op.urllib.request,'urlopen',side_effect=open_url),mock.patch.object(op,'UI_SHA',op.sha(asset)):
            self.assertEqual(op.live_ui()['sha256'],op.sha(asset))
        self.assertEqual([c.full_url for c in calls],['https://norva.tv/app','https://norva.tv'+op.UI_PATH])
        self.assertTrue(all(c.get_header('User-agent')=='Norva-Release-Verification/1.0' for c in calls))
        with mock.patch.object(op.urllib.request,'urlopen',side_effect=open_url),mock.patch.object(op,'UI_SHA','0'*64):
            with self.assertRaisesRegex(RuntimeError,'public_ui_bytes_drift'):op.live_ui()

    def test_source_has_no_runtime_deployment_or_driver_reset_and_uses_fresh_proofs(self):
        source=PATH.read_text()
        for denied in ('docker_api(','alter_crons(','subprocess.run(','SIGTERM','pg_cancel_backend','pg_terminate_backend'):
            self.assertNotIn(denied,source)
        self.assertIn(".open('x')",source)
        self.assertIn("0<=time.time()-proof['at']<=300",source)
        self.assertIn('prior_attempt_read_status_before_retry',source)
        self.assertIn('rollback_response_unresolved_read_state_no_retry',source)
        self.assertIn("wrapper.validate_profile(cfg,adapter)",source)
        self.assertIn("ROOT.parent==BASE",source)
        self.assertIn("'scoped_edge_attempt_required'",source)
        self.assertIn("'activation_directory_binding'",source)

if __name__=='__main__':unittest.main()
