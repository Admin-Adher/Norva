"""No production imports: executable scope, preservation and configuration proofs."""
import ast
import copy
import pathlib
import tempfile
import types
import unittest

HERE=pathlib.Path(__file__).parent
SOURCE=(HERE/'resume-enrichment-pilot9-20260912.py').read_text(encoding='utf8')
TREE=ast.parse(SOURCE)


def require(value,code):
    if not value:raise RuntimeError(code)


class ResumeTests(unittest.TestCase):
    def functions(self,names,ns):
        selected=[n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name in names]
        exec(compile(ast.Module(body=selected,type_ignores=[]),'resume-functions','exec'),ns)
        return ns

    def setup_selection(self):
        original={'rows':[{'sample':i,'fileKey':str(i),'external_id':'file-'+str(i)} for i in range(1,21)]}
        old={'rows':{str(i):{'state':'validating' if i<9 else 'planned' if i==9 else 'failed',
            'probeAttempts':1 if i!=9 else 0,'startIntentAt':'preserved' if i<9 else None} for i in range(1,21)}}
        values={i:{'job':{'state':'retry_wait','owned':True},'cache':'incomplete_tracks'} for i in range(1,21)}
        values[9]['job']=None
        ns=self.functions({'select_remaining'},{'copy':copy,'require':require,
            'TERMINAL':{'verified','completed','failed','expired','cancelled'},
            'pilot':types.SimpleNamespace(PENDING={'planned','validating','probe_intent','start_intent'},
                cache_result=lambda v:v.get('cache'))})
        return original,old,values,ns['select_remaining']

    def test_only_remaining_authorized_files_no_replacement_or_mutation(self):
        original,old,values,select=self.setup_selection()
        before=copy.deepcopy((original,old,values))
        rows,excluded=select(original,old,values)
        self.assertEqual([r['originalSample'] for r in rows],list(range(1,10)))
        self.assertEqual(excluded,[]);self.assertEqual((original,old,values),before)
        self.assertEqual([r['sample'] for r in rows],list(range(1,10)))

    def test_current_terminals_quarantines_and_identified_files_are_excluded(self):
        original,old,values,select=self.setup_selection()
        for i in (1,2,3,4):values[i]['job']['state']='failed'
        for i in (5,6):values[i]['job'].update(state='failed',quarantined=True)
        for i in (7,8):values[i].update(cache='verified')
        values[9]['job']=None
        rows,excluded=select(original,old,values)
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['originalSample'],9)
        self.assertEqual([x['reason'] for x in excluded],['terminal_job']*4+['quarantined']*2+['already_identified']*2)

    def test_external_jobs_lost_intents_and_missing_sources_are_protected(self):
        original,old,values,select=self.setup_selection()
        values[1]['job']['owned']=False
        old['rows']['2']['startIntentAt']=None
        values[3]=None
        values[4]['job']=None;old['rows']['4']['state']='probe_intent'
        rows,excluded=select(original,old,values)
        self.assertEqual([r['originalSample'] for r in rows],[5,6,7,8,9])
        self.assertEqual(len(excluded),4)

    def test_original_denominator_and_nine_authorized_samples_cannot_drift(self):
        original,old,values,select=self.setup_selection()
        old['rows']['10']['state']='planned'
        with self.assertRaisesRegex(RuntimeError,'authorized_parent_scope_changed'):select(original,old,values)
        old['rows']['10']['state']='failed';original['rows'].pop()
        with self.assertRaisesRegex(RuntimeError,'authorized_parent_scope_changed'):select(original,old,values)

    def test_duplicate_file_keys_fail_closed(self):
        original,old,values,select=self.setup_selection()
        original['rows'][1]['fileKey']=original['rows'][0]['fileKey']
        with self.assertRaisesRegex(RuntimeError,'subset_duplicate'):select(original,old,values)

    def test_runner_binding_has_bounded_count_and_own_private_root(self):
        tree=ast.parse((HERE/'run-enrichment-pilot20-20260911.py').read_text(encoding='utf8'))
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='configure')
        module=types.SimpleNamespace(ROOT=pathlib.PurePosixPath('/private/resume'),pilot=types.SimpleNamespace(),require=require)
        ns={'release':types.SimpleNamespace(require=require),'scoped_controls':object()}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'configure-subset','exec'),ns)
        for count in (1,9,20):
            ns['configure'](module,count)
            self.assertEqual(ns['MAX_FILES'],count)
            self.assertEqual(module.pilot.ROOT,pathlib.PurePosixPath('/private/resume/pilot'))
            self.assertEqual(ns['dispatch_healthy_at'],0)
        for count in (0,21,True,1.5):
            with self.assertRaisesRegex(RuntimeError,'subset_size_invalid'):ns['configure'](module,count)

    def test_no_job_reset_new_model_or_proxy_mutation(self):
        self.assertNotIn('UPDATE public.catalog_file_audio_validation_jobs',SOURCE)
        self.assertNotIn('DELETE FROM',SOURCE);self.assertNotIn('TRUNCATE',SOURCE)
        self.assertNotIn('PROVIDER_PROXY_',SOURCE)
        self.assertIn("'originalDenominator':20",SOURCE)
        self.assertIn("original['expiresEpoch']",SOURCE)
        self.assertIn("copy.deepcopy(old_state['rows'][str(r['originalSample'])])",SOURCE)
        self.assertIn("protected_rows(list(plan['protectedJobs']))==plan['protectedJobs']",SOURCE)

    def test_closure_waits_for_operator_provider_and_private_audio(self):
        fn=next(n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name=='finish')
        body=ast.get_source_segment(SOURCE,fn)
        self.assertIn("require(not process_active('operator','run')",body)
        self.assertIn('d.idle()',body)
        self.assertIn("('entries','bytes','reservations','computations')",body)
        self.assertIn("replace_gateway(plan,False,'completed')",body)
        self.assertIn('prior.alter_crons(plan,False)',body)
        self.assertLess(body.index('d.idle()'),body.index('replace_gateway('))

    def test_predeployment_closure_restores_crons_while_unrelated_inference_continues(self):
        events=[]
        plan={'expiresEpoch':2000,'rows':[{}],'parentPlan':{}}
        with tempfile.TemporaryDirectory() as directory:
            ns=self.functions({'finish'},{'ROOT':pathlib.Path(directory),'require':require,
                'saved':lambda name:plan if name=='plan.private.json' else {'launchDeadline':1500},
                'invariant':lambda _:events.append('invariant'),'time':types.SimpleNamespace(time=lambda:1000),
                'pilot':types.SimpleNamespace(ROOT=pathlib.Path(directory),private=lambda _:{'runtimeStatus':'stopped'}),
                'process_active':lambda *_:False,'d':types.SimpleNamespace(SERVICES=['gateway'],FLAGS=['flag'],
                    idle=lambda:(_ for _ in ()).throw(AssertionError('must not await unrelated inference')),
                    verify_service=lambda *_:events.append('unchanged_gateway_verified')),
                'sql':lambda *_,**__:events.append('flags_disabled'),'fleet':types.SimpleNamespace(literal=lambda k:"'"+k+"'"),
                'prior':types.SimpleNamespace(alter_crons=lambda _,pause:events.append(('crons_paused',pause))),
                'save':lambda *_:events.append('closed_receipt'),'stamp':lambda:'now','json':__import__('json'),
                'print':lambda *_args,**_kwargs:None})
            self.assertTrue(ns['finish']())
            self.assertIn('unchanged_gateway_verified',events)
            self.assertIn(('crons_paused',False),events)
            self.assertIn('closed_receipt',events)

    def test_predeployment_abort_cannot_interrupt_or_overwrite_a_started_release(self):
        fn=next(n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name=='abort_before_deploy')
        body=ast.get_source_segment(SOURCE,fn)
        self.assertIn('before-resume-intent.private.json',body)
        self.assertIn('operator.private.json',body)
        self.assertIn("plan['gatewayBefore']['Id']",body)
        self.assertNotIn('kill(',body);self.assertNotIn('replace_gateway(',body)


if __name__=='__main__':unittest.main()
