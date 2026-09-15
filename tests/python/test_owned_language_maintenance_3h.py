"""Offline clock/ownership tests. No private helpers, Docker or production SQL."""
import ast, copy, importlib.util, json, pathlib, tempfile, types, unittest
from unittest import mock
PATH=pathlib.Path(__file__).resolve().parents[2]/'ops/hetzner/scripts/deploy-owned-language-maintenance-3h-20260915.py'
spec=importlib.util.spec_from_file_location('three_hour_under_test',PATH)
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class ThreeHourTests(unittest.TestCase):
    def rows(self):return [{'id':id,'name':name,'active':True,'spec':str(i+1)*32} for i,(id,name) in enumerate(op.CRONS.items())]
    def base(self,root):
        plan={'stagedAt':950,'crons':self.rows()}
        values={'plan.private.json':plan,'begin.private.json':{'at':1000,'deadline':11800,'maxPauseSeconds':10800,'authorization':op.ACK}}
        current=copy.deepcopy(plan['crons'])
        r=types.SimpleNamespace(crons=mock.Mock(side_effect=lambda:copy.deepcopy(current)))
        def restore(plan,pause):
            self.assertFalse(pause);current[:]=copy.deepcopy(plan['crons'])
        r.alter_crons=mock.Mock(side_effect=restore)
        def save(name,value):
            self.assertFalse((root/name).exists());values[name]=copy.deepcopy(value)
            (root/name).write_text(json.dumps(value))
        base=types.SimpleNamespace(saved=lambda name:values[name],invariant=mock.Mock(),save=mock.Mock(side_effect=save),
            spawn=mock.Mock(),process_alive=mock.Mock(return_value=True),core=types.SimpleNamespace(base=types.SimpleNamespace(r=r)))
        def spawn(phase):
            if phase=='pause-watch':save('pause-ready.private.json',{'at':1000,'deadline':11800,'cronIds':sorted(op.CRONS)})
        base.spawn.side_effect=spawn
        return base,values,current,r

    def test_exact_three_hours_and_both_guards_before_runner(self):
        with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=1000):
            base,values,_,_=self.base(op.ROOT);op.install_bounded_launch(base);base.launch()
            self.assertEqual(values['begin.private.json'],{'at':1000,'deadline':11800,'maxPauseSeconds':10800,'authorization':op.ACK})
            self.assertEqual(base.spawn.call_args_list,[mock.call('pause-watch'),mock.call('watch'),mock.call('run')])
            base.invariant.assert_called_once()

    def test_either_guard_missing_prevents_runner(self):
        for phase in ('pause-watch','watch'):
            with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=1000):
                base,_,_,_=self.base(op.ROOT);base.process_alive.side_effect=lambda name:name!=phase
                op.install_bounded_launch(base)
                with self.assertRaisesRegex(RuntimeError,'guard_missing'):base.launch()
                self.assertNotIn(mock.call('run'),base.spawn.call_args_list)

    def test_alive_but_uninitialized_pause_guard_cannot_start_runner(self):
        for mode in ('absent','wrong-binding'):
            with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=1000):
                base,values,_,_=self.base(op.ROOT);base.spawn.side_effect=None
                if mode=='wrong-binding':
                    base.save('pause-ready.private.json',{'at':1000,'deadline':11801,'cronIds':sorted(op.CRONS)})
                op.install_bounded_launch(base)
                with mock.patch.object(op.time,'monotonic',side_effect=[0,1,31]),mock.patch.object(op.time,'sleep'):
                    with self.assertRaisesRegex(RuntimeError,'pause_guard_(not_ready|ready_binding)'):base.launch()
                self.assertNotIn(mock.call('run'),base.spawn.call_args_list)
                self.assertNotIn(mock.call('watch'),base.spawn.call_args_list)

    def test_launched_closed_or_failed_attempt_is_never_reused(self):
        for marker in ('begin.private.json','closed.private.json','failed.private.json'):
            with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=1000):
                base,_,_,_=self.base(op.ROOT);(op.ROOT/marker).touch();op.install_bounded_launch(base)
                with self.assertRaisesRegex(RuntimeError,'prior_launch_no_retry'):base.launch()
                base.save.assert_not_called();base.spawn.assert_not_called()

    def test_expired_future_or_changed_stage_refused_without_writes(self):
        for stamp,drift in ((600,False),(1001,False),(950,True)):
            with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=1000):
                base,values,current,_=self.base(op.ROOT);values['plan.private.json']['stagedAt']=stamp
                if drift:current[0]['spec']='f'*32
                op.install_bounded_launch(base)
                with self.assertRaisesRegex(RuntimeError,'stage_expired_or_cron_drift'):base.launch()
                base.save.assert_not_called();base.spawn.assert_not_called()

    def test_window_cannot_be_extended_shortened_or_reauthorized(self):
        begin={'at':1000,'deadline':11800,'maxPauseSeconds':10800,'authorization':op.ACK}
        op.validate_window(begin)
        for change in ({'deadline':11801},{'at':999},{'deadline':float('inf')},{'at':True},
                       {'maxPauseSeconds':3600},{'authorization':'cancel-media'}):
            with self.subTest(change=change),self.assertRaises(RuntimeError):op.validate_window({**begin,**change})

    def test_exact_two_scheduler_identities_no_other_cron(self):
        op.validate_crons({'crons':self.rows()})
        for rows in (self.rows()[:1],self.rows()+[{'id':180}],
                     [{**self.rows()[0],'id':180},self.rows()[1]],
                     [{**self.rows()[0],'spec':'invalid'},self.rows()[1]],
                     [{**self.rows()[0],'active':1},self.rows()[1]]):
            with self.assertRaisesRegex(RuntimeError,'authorized_two_crons_only'):op.validate_crons({'crons':rows})

    def test_watchdog_waits_without_mutation_then_restores_even_when_runtime_not_closed(self):
        now=[1001]
        with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',side_effect=lambda:now[0]):
            base,values,current,r=self.base(op.ROOT)
            for row in current:row['active']=False
            def advance(_):
                r.alter_crons.assert_not_called();now[0]=11800-op.RESTORE_MARGIN_SECONDS
            with mock.patch.object(op.time,'sleep',side_effect=advance):op.watch_pause(base)
            r.alter_crons.assert_called_once_with(values['plan.private.json'],False)
            receipt=values['pause-closed.private.json']
            self.assertTrue(receipt['cronsRestored']);self.assertTrue(receipt['withinAuthorizedWindow'])
            self.assertFalse(receipt['runtimeClosed']);base.spawn.assert_not_called()
            self.assertEqual(values['begin.private.json']['deadline'],11800)

    def test_already_restored_closed_release_needs_no_second_write(self):
        with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=1050):
            base,values,_,r=self.base(op.ROOT);(op.ROOT/'closed.private.json').touch();op.watch_pause(base)
            r.alter_crons.assert_not_called();self.assertTrue(values['pause-closed.private.json']['runtimeClosed'])

    def test_lost_restore_response_is_read_before_any_retry(self):
        now=[11710]
        with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',side_effect=lambda:now[0]):
            base,values,current,r=self.base(op.ROOT)
            for row in current:row['active']=False
            def uncertain(plan,pause):
                self.assertFalse(pause);current[:]=copy.deepcopy(plan['crons']);raise TimeoutError()
            r.alter_crons.side_effect=uncertain
            with mock.patch.object(op.time,'sleep',side_effect=lambda _:now.__setitem__(0,now[0]+2)):op.watch_pause(base)
            self.assertEqual(r.alter_crons.call_count,1)
            self.assertTrue(values['pause-closed.private.json']['withinAuthorizedWindow'])
            self.assertIn('pause-restore-error.private.json',values)

    def test_unresolved_restore_records_failure_without_renewing_authority(self):
        now=[11710]
        with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',side_effect=lambda:now[0]):
            base,values,current,r=self.base(op.ROOT)
            for row in current:row['active']=False
            r.alter_crons.side_effect=RuntimeError('foreign cron definition')
            with mock.patch.object(op.time,'sleep',side_effect=lambda _:now.__setitem__(0,now[0]+110)):
                with self.assertRaisesRegex(RuntimeError,'cron_restore_not_confirmed'):op.watch_pause(base)
            self.assertFalse(values['pause-requires-review.private.json']['authorizationExtended'])
            self.assertEqual(values['begin.private.json']['deadline'],11800);base.spawn.assert_not_called()

    def test_late_restore_is_not_claimed_within_authorized_window(self):
        with tempfile.TemporaryDirectory() as d,mock.patch.object(op,'ROOT',pathlib.Path(d)),mock.patch.object(op.time,'time',return_value=11801):
            base,values,current,_=self.base(op.ROOT)
            for row in current:row['active']=False
            op.watch_pause(base);self.assertFalse(values['pause-closed.private.json']['withinAuthorizedWindow'])

    def test_exact_profile_payload_and_unchanged_runtime_guards(self):
        post=types.SimpleNamespace(CANDIDATE={'only':['unused']},LIVE_PLAYBACK_SHA='v',assert_vod_runtime=mock.Mock())
        cfg={'profile':op.PROFILE,'maxPauseSeconds':10800,'authorization':op.ACK,'attemptDirectory':op.ROOT.name,
             'edgeFiles':{'only':['old',['unused']]}}
        adapter=types.SimpleNamespace(validate=mock.Mock(),BASE_HASHES={'other':'same'},HELPERS={})
        with mock.patch.object(op,'pinned_post_vod',return_value=post):
            op.validate_profile(cfg,adapter)
            for change in ({'profile':'post-vod'},{'maxPauseSeconds':3600},{'maxPauseSeconds':10801},
                           {'authorization':'cancel-media'},{'attemptDirectory':'../foreign'},{'edgeFiles':{}}):
                with self.assertRaises(RuntimeError):op.validate_profile({**cfg,**change},adapter)
            with tempfile.TemporaryDirectory() as d:
                base,_,_,_=self.base(pathlib.Path(d))
                callbacks={name:object() for name in ('idle','run','watch','recover','activate')}
                controller=types.SimpleNamespace(base=base,**callbacks,stage=mock.Mock(),initialize=mock.Mock())
                old_stage,old_init=controller.stage,controller.initialize
                adapter.adapt=mock.Mock(return_value=controller);op.configure(adapter,object())
                actual=adapter.adapt(controller,cfg,object());actual.initialize();actual.stage()
                old_init.assert_called_once();old_stage.assert_called_once();post.assert_vod_runtime.assert_called_once_with(controller)
                for name,value in callbacks.items():self.assertIs(getattr(actual,name),value)
                self.assertEqual(adapter.BASE_HASHES['other'],'same')

    def test_no_media_cancel_or_runtime_recovery_bypass(self):
        source=PATH.read_text();tree=ast.parse(source)
        stores=[n.attr for n in ast.walk(tree) if isinstance(n,ast.Attribute) and isinstance(n.ctx,ast.Store)]
        for name in ('idle','run','watch','recover','activate','controls','alter_crons','verify_sql','verify_edge'):
            self.assertNotIn(name,stores)
        for forbidden in ('docker_api(', 'write=True','UPDATE ','DELETE ','terminate(', 'kill('):self.assertNotIn(forbidden,source)
        self.assertIn('r.alter_crons(plan,False)',source)

if __name__=='__main__':unittest.main()
