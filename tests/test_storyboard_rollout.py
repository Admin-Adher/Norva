"""Exercise actual deployment preparation and idle guards with controlled Docker state."""
import copy,importlib.util,pathlib,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('rollout',pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/media/rollout-storyboard-durability.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class RolloutTests(unittest.TestCase):
    def original(self):
        return {'Id':'existing','Image':'sha256:'+'a'*64,'Name':'/norva-media-gateway','Config':{
            'Image':'sha256:'+'a'*64,'Env':['GATEWAY_TOKEN=private-test-value','UNRELATED=keep'], 'Labels':{}},
            'HostConfig':{'Binds':['/private:/var/lib/norva-storyboards']},
            'NetworkSettings':{'Networks':{'norva_default':{'Aliases':['gateway']}}},
            'Mounts':[{'Destination':'/var/lib/norva-storyboards','RW':True}]}
    def test_only_allowlisted_environment_changes_preserve_network_mounts_and_secret(self):
        original=self.original();before=copy.deepcopy(original)
        after=r.prepared(original,'sha256:'+'b'*64,2000,[])
        self.assertEqual(original,before)
        self.assertEqual(after['HostConfig'],original['HostConfig'])
        self.assertIn('GATEWAY_TOKEN=private-test-value',after['Env'])
        self.assertIn('UNRELATED=keep',after['Env'])
        self.assertEqual(after['NetworkingConfig']['EndpointsConfig']['norva_default']['Aliases'],['gateway'])
    def test_no_persistence_outside_an_existing_writable_mount(self):
        for mounts in [[],[{'Destination':'/var/lib/norva-storyboards','RW':False}],[{'Destination':'/elsewhere','RW':True}]]:
            original=self.original();original['Mounts']=mounts
            with self.assertRaisesRegex(AssertionError,'persistent_mount_missing'):r.prepared(original,'sha256:'+'b'*64,10000,[])
    def test_reject_invalid_scope_before_any_runtime_action(self):
        for bps,sources in [(-1,[]),(10001,[]),(2000,['*']),(10000,['../escape'])]:
            with self.assertRaises(AssertionError):r.prepared(self.original(),'sha256:'+'b'*64,bps,sources)
    def test_ready_or_pending_cloud_playback_blocks_restart(self):
        original=self.original()
        zero=['activeSessions','rawPumpCount','viewerSessionStartupAdmissions','viewerStartupReservations','viewerSessionStartupWaiters',
            'viewerSessionStartupLockCount','backgroundCpuProcessCount','whisperInferenceActive','argosInferenceActive','activeStrictLidBrokers',
            'transcribeQueueDepth','ocrQueueDepth','translateQueueDepth']
        h={'ok':True,'version':169,**{k:0 for k in zero},'videoEncoderCapacity':{'active':0},
            **{k:False for k in ['transcribeBusy','ocrBusy','translateBusy','lidBenchmarkBusy']}}
        with patch.object(r,'inspect',return_value=original),patch.object(r,'health',side_effect=lambda n,o,debug=False:{'sessions':[]} if debug else h),patch.object(r.subprocess,'check_output',return_value='1') as query:
            with self.assertRaisesRegex(AssertionError,'cloud_playback_active'):r.idle('norva-media-gateway',original)
            self.assertIn("status in ('ready','pending','active')",query.call_args.args[0][-1])
        h['transcribeQueueDepth']=1
        with patch.object(r,'inspect',return_value=original),patch.object(r,'health',return_value=h):
            with self.assertRaisesRegex(AssertionError,'busy_or_unknown_transcribeQueueDepth'):r.idle('norva-media-gateway',original)
if __name__=='__main__':unittest.main()
