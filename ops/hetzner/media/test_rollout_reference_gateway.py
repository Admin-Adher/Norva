"""Safety contracts for the rollout planner; no Docker or network access."""
import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollout', pathlib.Path(__file__).with_name('rollout-reference-gateway.py'))
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


def container():
    return {'Id': 'original', 'Config': {'Hostname': 'assigned', 'Image': 'base',
            'Labels': {'deployment': 'old'}, 'Env': ['GATEWAY_TOKEN=synthetic', 'FEATURE=true'],
            'User': '1000:1000'},
            'HostConfig': {'Binds': ['/private/cache:/cache:rw'], 'Memory': 1024,
                           'OomKillDisable': None, 'Devices': [{'PathOnHost': '/dev/dri/renderD128'}]},
            'NetworkSettings': {'Networks': {'production': {'Aliases': ['gateway'],
                'IPAddress': '172.20.0.4', 'EndpointID': 'assigned-runtime-id'}}}}


def empty_health():
    h = dict.fromkeys(['activeSessions', 'rawPumpCount', 'viewerSessionStartupAdmissions',
                      'viewerStartupReservations', 'viewerSessionStartupWaiters',
                      'viewerSessionStartupLockCount', 'backgroundCpuProcessCount',
                      'whisperInferenceActive', 'argosInferenceActive', 'activeStrictLidBrokers'], 0)
    h.update(dict.fromkeys(['transcribeBusy', 'ocrBusy', 'translateBusy', 'lidBenchmarkBusy'], False))
    return {**h, 'ok': True, 'version': 167, 'videoEncoderCapacity': {'active': 0}}


class RolloutSafety(unittest.TestCase):
    def test_reviewed_image_parameters_require_exact_digests_and_revision(self):
        base = 'sha256:' + 'a' * 64
        image = 'sha256:' + 'b' * 64
        revision = 'c' * 40
        rollout.validate_rollout_parameters(base, image, revision, 167, 168)
        for candidate in [(base, base, revision, 167, 168),
                          ('tag:latest', image, revision, 167, 168),
                          (base, image, 'main', 167, 168),
                          (base, image, revision, 0, 168)]:
            with self.subTest(candidate=candidate), self.assertRaises(AssertionError):
                rollout.validate_rollout_parameters(*candidate)

    def test_existing_pilot_output_mount_is_preserved_without_recopied_data(self):
        current = container()
        current['Mounts'] = [{'Destination': '/tmp/resume-pilot'}]
        self.assertFalse(rollout.pilot_output_copy_needed(
            'norva-resume-cache-pilot-20260916', current, True))
        self.assertFalse(rollout.pilot_output_copy_needed('norva-media-gateway', current, False))
        with self.assertRaises(AssertionError):
            rollout.pilot_output_copy_needed('norva-media-gateway', current, True)
        current['Mounts'] = []
        with self.assertRaises(AssertionError):
            rollout.pilot_output_copy_needed('norva-resume-cache-pilot-20260916', current, True)

    def test_clone_preserves_credentials_mounts_limits_and_dns_without_mutation(self):
        original = container()
        before = copy.deepcopy(original)
        config = rollout.clone(original)
        self.assertEqual(config['Env'], before['Config']['Env'])
        self.assertEqual(config['HostConfig'], before['HostConfig'])
        self.assertEqual(config['NetworkingConfig'], {'EndpointsConfig': {'production': {'Aliases': ['gateway']}}})
        config['Env'].append('NEW=true')
        self.assertEqual(original, before)

    def test_contract_rejects_secret_storage_resource_and_route_drift(self):
        config = rollout.clone(container())
        baseline = rollout.contract(config)
        for mutate in [lambda c: c['Env'].append('DIFFERENT=true'),
                       lambda c: c['HostConfig']['Binds'].append('/other:/cache:rw'),
                       lambda c: c['HostConfig'].update(Memory=2048),
                       lambda c: c['NetworkingConfig']['EndpointsConfig']['production'].update(Aliases=['other'])]:
            changed = copy.deepcopy(config)
            mutate(changed)
            self.assertNotEqual(rollout.contract(changed), baseline)
        config.update(Image='replacement', Hostname='new-runtime', Labels={'deployment': 'new'})
        config['HostConfig']['OomKillDisable'] = False
        self.assertEqual(rollout.contract(config), baseline)

    def check_idle(self, h, debug=None, native='0'):
        original = container()
        with patch.object(rollout, 'inspect', return_value=original), \
             patch.object(rollout, 'health', side_effect=[h, {'sessions': []} if debug is None else debug]), \
             patch.object(rollout.subprocess, 'check_output', return_value=native):
            return rollout.idle('norva-media-gateway', original)

    def test_idle_requires_positive_evidence_not_missing_counters(self):
        self.check_idle(empty_health())
        for key in ['viewerStartupReservations', 'whisperInferenceActive', 'activeStrictLidBrokers']:
            for value in [1, None, '0', False]:
                h = empty_health()
                h[key] = value
                with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                    self.check_idle(h)
        with self.assertRaises(AssertionError):
            self.check_idle(empty_health(), debug={})

    def test_viewer_and_native_cloud_grants_prevent_stop(self):
        with self.assertRaises(AssertionError):
            self.check_idle(empty_health(), debug={'sessions': [{'id': 'viewer'}]})
        with self.assertRaises(AssertionError):
            self.check_idle(empty_health(), native='1')


if __name__ == '__main__':
    unittest.main()
