"""Offline tests; production helpers, files, containers and SQL are never loaded."""
import ast, importlib.util, pathlib, tempfile, types, unittest
from unittest import mock
PATH=pathlib.Path(__file__).resolve().parents[2]/'ops/hetzner/scripts/deploy-owned-language-maintenance-60m-20260914.py'
spec=importlib.util.spec_from_file_location('maintenance_60m_under_test',PATH)
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class MaintenanceTests(unittest.TestCase):
    def base(self):
        return types.SimpleNamespace(saved=mock.Mock(return_value={'stagedAt':950,'crons':['expected']}),
          invariant=mock.Mock(),save=mock.Mock(),spawn=mock.Mock(),process_alive=mock.Mock(return_value=True),
          core=types.SimpleNamespace(base=types.SimpleNamespace(r=types.SimpleNamespace(crons=lambda:['expected']))))
    def test_bound_to_only_approved_hour(self):
        base=self.base()
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(op,'ROOT',pathlib.Path(folder)), mock.patch.object(op.time,'time',return_value=1000):
            op.install_bounded_launch(base);base.launch()
        self.assertEqual(base.save.call_args.args,('begin.private.json',{'at':1000,'deadline':4600,
            'maxPauseSeconds':3600,'authorization':op.ACK}))
        self.assertEqual(base.spawn.call_args_list,[mock.call('watch'),mock.call('run')])
    def test_dead_guard_never_spawns_runner(self):
        base=self.base();base.process_alive.return_value=False
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(op,'ROOT',pathlib.Path(folder)), mock.patch.object(op.time,'time',return_value=1000):
            op.install_bounded_launch(base)
            with self.assertRaisesRegex(RuntimeError,'guard_missing'):base.launch()
        base.spawn.assert_called_once_with('watch')
    def test_expired_future_or_changed_crons_reject_before_writes(self):
        for staged,crons in [(600,['expected']),(1001,['expected']),(950,['other'])]:
            base=self.base();base.saved.return_value={'stagedAt':staged,'crons':crons}
            with mock.patch.object(op.time,'time',return_value=1000):
                op.install_bounded_launch(base)
                with self.assertRaisesRegex(RuntimeError,'stage_expired_or_cron_drift'):base.launch()
            base.save.assert_not_called();base.spawn.assert_not_called()
    def test_cannot_reuse_launched_attempt(self):
        base=self.base()
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(op,'ROOT',pathlib.Path(folder)), mock.patch.object(op.time,'time',return_value=1000):
            (op.ROOT/'begin.private.json').touch();op.install_bounded_launch(base)
            with self.assertRaisesRegex(RuntimeError,'prior_launch_no_retry'):base.launch()
        base.save.assert_not_called();base.spawn.assert_not_called()
    def test_metadata_and_idle_and_recovery_are_not_overridden(self):
        source=PATH.read_text();tree=ast.parse(source)
        attrs=[node.attr for node in ast.walk(tree) if isinstance(node,ast.Attribute) and isinstance(node.ctx,ast.Store)]
        for name in ('idle','run','watch','recover','activate','alter_crons','controls','verify_sql','verify_edge'):
            self.assertNotIn(name,attrs)
        for forbidden in ('docker_api(', 'write=True', 'UPDATE ', 'DELETE ', 'terminate(', 'kill('):self.assertNotIn(forbidden,source)
    def test_adapter_initializes_existing_guards_and_only_replaces_launch(self):
        callbacks={name:object() for name in ('idle','run','watch','recover','activate')}
        base=self.base()
        for name,value in callbacks.items():setattr(base,name,value)
        original=mock.Mock()
        controller=types.SimpleNamespace(base=base,initialize=original)
        adapter=types.SimpleNamespace(adapt=mock.Mock(return_value=controller),HELPERS={})
        with mock.patch.object(op,'private_file') as file:
            file.return_value.read_bytes.return_value=b'bound'
            op.configure_adapter(adapter)
        actual=adapter.adapt(controller,{},object())
        self.assertIs(actual,controller);self.assertEqual(actual.ACK,op.ACK)
        actual.initialize();original.assert_called_once()
        self.assertTrue(callable(base.launch))
        for name,value in callbacks.items():self.assertIs(getattr(base,name),value)
        self.assertEqual(adapter.ROOT,op.ROOT);self.assertIn(op.ADAPTER,adapter.HELPERS)
    def test_binding_rejects_longer_window_wrong_payload_or_unbound_operator(self):
        cfg={'sourceCommit':op.SOURCE_COMMIT,'operatorCommit':'a'*40,'maxPauseSeconds':3600,
            'authorization':op.ACK,'operatorSha256':op.sha(PATH.read_bytes())}
        op.validate_binding(cfg)
        for change in ({'maxPauseSeconds':3601},{'maxPauseSeconds':60},{'sourceCommit':'b'*40},
                       {'authorization':'cancel-media'},{'operatorSha256':'b'*64},{'operatorCommit':'unknown'}):
            with self.assertRaises(RuntimeError):op.validate_binding({**cfg,**change})
    def test_previous_attempt_must_be_closed_without_any_activation(self):
        cfg={'commit':op.SOURCE_COMMIT,'operatorSha256':op.ADAPTER_SHA}
        closed={'commit':op.SOURCE_COMMIT,'updated':False,'edgeNeverActivated':True,'oldEdgeRestored':True,'cronsRestored':True}
        with mock.patch.object(op,'private_file') as file, mock.patch.object(op,'sha',return_value=op.ADAPTER_SHA):
            for change in ({'updated':True},{'edgeNeverActivated':False},{'oldEdgeRestored':False},
                           {'cronsRestored':False},{'commit':'b'*40}):
                with mock.patch.object(op,'read',side_effect=[cfg,{**closed,**change}]):
                    with self.assertRaisesRegex(RuntimeError,'previous_attempt_not_safely_closed'):op.previous_binding()
            with mock.patch.object(op,'read',side_effect=[cfg,closed]):self.assertEqual(op.previous_binding(),cfg)
    def test_prepare_refuses_unfresh_or_symlinked_inputs(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(op,'ROOT',pathlib.Path(folder)):
            (op.ROOT/'unexpected').touch()
            with self.assertRaisesRegex(RuntimeError,'retry_directory_not_fresh'):op.prepare({}, {})
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError,'bound_artifact_missing'):op.private_file(pathlib.Path(folder),'missing')

if __name__=='__main__':unittest.main()
