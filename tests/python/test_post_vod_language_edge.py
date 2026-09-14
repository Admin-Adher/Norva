"""Offline post-VOD binding tests. Never load production helpers or contact Docker."""
import ast, copy, importlib.util, json, pathlib, types, unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
PATH=ROOT/'ops/hetzner/scripts/deploy-post-vod-language-edge-20260914.py'
spec=importlib.util.spec_from_file_location('post_vod_under_test',PATH)
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class PostVodTests(unittest.TestCase):
    def cfg(self):return {'profile':'post-vod','maxPauseSeconds':3600,'authorization':op.ACK,'attemptDirectory':op.ROOT.name,
        'edgeFiles':{name:['baseline',digest] for name,digest in op.CANDIDATE.items()}}
    def test_exact_payload_and_approved_window(self):
        adapter=types.SimpleNamespace(validate=mock.Mock());cfg=self.cfg()
        op.validate_profile(cfg,adapter);adapter.validate.assert_called_once_with(cfg)
        for change in ({'maxPauseSeconds':3601},{'profile':'old'},{'authorization':'cancel-storyboards'},{'attemptDirectory':'../foreign'}):
            with self.assertRaises(RuntimeError):op.validate_profile({**cfg,**change},adapter)
        cfg['edgeFiles']['norva-playback/index.ts'][1]='0'*64
        with self.assertRaisesRegex(RuntimeError,'payload_drift'):op.validate_profile(cfg,adapter)
    def test_runtime_requires_coordinated_images_and_both_trees(self):
        hashes={'norva-playback/index.ts':op.LIVE_PLAYBACK_SHA,**{str(n):'x' for n in range(159)}}
        gateway={'Id':'gateway','Image':op.GATEWAY_IMAGE,'Config':{'Image':'norva-media-gateway:vod-clock-20260914'}}
        edge={'Image':op.EDGE_IMAGE}
        runtime=types.SimpleNamespace(gw=types.SimpleNamespace(inspect=lambda name=None:gateway if name is None else edge),
            base=types.SimpleNamespace(SERVICES=['first','second'],edge=types.SimpleNamespace(hashes=lambda root:hashes),
              lib=types.SimpleNamespace(edge_root=lambda c:'/audited/root')))
        def digest(args,**kwargs):return types.SimpleNamespace(stdout=op.GATEWAY_FILES[args[-1]]+'  file')
        with mock.patch.object(op.subprocess,'run',side_effect=digest) as calls,mock.patch.object(op,'sha',return_value=op.LIVE_TREE_SHA):
            op.assert_vod_runtime(runtime);self.assertEqual(calls.call_count,2)
            edge['Image']='other'
            with self.assertRaisesRegex(RuntimeError,'edge_baseline'):op.assert_vod_runtime(runtime)
            edge['Image']=op.EDGE_IMAGE;gateway['Image']='other'
            with self.assertRaisesRegex(RuntimeError,'gateway_image'):op.assert_vod_runtime(runtime)
    def test_existing_guards_preserved_and_new_launch_initialized(self):
        lifecycle={name:object() for name in ('idle','run','watch','recover','activate')}
        controller=types.SimpleNamespace(**lifecycle,base=object(),stage=mock.Mock(),initialize=mock.Mock())
        original_stage,original_init=controller.stage,controller.initialize
        adapter=types.SimpleNamespace(BASE_HASHES={'another':'same','norva-playback/index.ts':'old'},HELPERS={},
            validate=mock.Mock(),adapt=mock.Mock(return_value=controller))
        timing=types.SimpleNamespace(install_bounded_launch=mock.Mock())
        op.configure(adapter,timing);actual=adapter.adapt(controller,self.cfg(),object())
        for name,value in lifecycle.items():self.assertIs(getattr(actual,name),value)
        self.assertEqual(adapter.BASE_HASHES,{'another':'same','norva-playback/index.ts':op.LIVE_PLAYBACK_SHA})
        with mock.patch.object(op,'assert_vod_runtime') as check:
            actual.stage();check.assert_called_once_with(controller);original_stage.assert_called_once()
        actual.initialize();original_init.assert_called_once();timing.install_bounded_launch.assert_called_once_with(controller.base)
        self.assertEqual(timing.ROOT,op.ROOT);self.assertEqual(actual.ACK,op.ACK)
    def test_no_idle_recovery_flags_gateway_mutation_or_job_cancel_override(self):
        source=PATH.read_text();tree=ast.parse(source)
        attrs=[node.attr for node in ast.walk(tree) if isinstance(node,ast.Attribute) and isinstance(node.ctx,ast.Store)]
        for name in ('idle','recover','watch','run','activate','controls','alter_crons'):
            self.assertNotIn(name,attrs)
        for forbidden in ('write=True','docker_api(','SIGTERM','kill(','UPDATE ','DELETE '):self.assertNotIn(forbidden,source)
        self.assertIn("'sha256sum'",source)
        self.assertIn("ROOT.parent==BASE",source)
        self.assertIn("'post-vod-language-edge-20260914-[0-9]{14}'",source)

if __name__=='__main__':unittest.main()
