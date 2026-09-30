"""Exercise the actual complete-image rollout idle guard without Docker mutation."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'reference_rollout', pathlib.Path(__file__).resolve().parents[1]
    / 'ops/hetzner/media/rollout-reference-gateway.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ReferenceRolloutIdleTests(unittest.TestCase):
    def setUp(self):
        self.original = {
            'Id': 'unchanged-container',
            'Config': {'Image': 'sha256:' + 'a' * 64, 'Env': [], 'Labels': {}},
            'HostConfig': {'Binds': ['/existing:/data']},
            'NetworkSettings': {'Networks': {'norva': {'Aliases': ['gateway']}}},
        }
        zeros = (
            'activeSessions', 'rawPumpCount', 'viewerSessionStartupAdmissions',
            'viewerStartupReservations', 'viewerSessionStartupWaiters',
            'viewerSessionStartupLockCount', 'backgroundCpuProcessCount',
            'whisperInferenceActive', 'argosInferenceActive', 'activeStrictLidBrokers')
        self.health = {
            'ok': True, 'version': r.CURRENT_VERSION,
            **dict.fromkeys(zeros, 0), 'videoEncoderCapacity': {'active': 0},
            **dict.fromkeys(('transcribeBusy', 'ocrBusy', 'translateBusy', 'lidBenchmarkBusy'), False),
        }

    def run_idle(self, count):
        with patch.object(r, 'inspect', return_value=self.original), \
                patch.object(r, 'health', side_effect=lambda name, original, debug=False:
                             {'sessions': []} if debug else self.health), \
                patch.object(r.subprocess, 'check_output', return_value=count) as query:
            try:
                return r.idle('norva-media-gateway', self.original)
            finally:
                if query.called:
                    args = query.call_args.args[0]
                    self.assertEqual(args[:4], ['docker', 'exec', 'norva-db', 'psql'])
                    self.assertEqual(args[-2], '-c')
                    self.assertEqual(args[-1],
                        "select count(*) from cloud_playback_sessions where status in ('pending','ready') and expires_at>now();")
                    self.assertNotIn('playback_hint', args[-1])
                    query.assert_called_once()

    def test_unexpired_pending_or_ready_session_blocks_even_when_gateway_empty(self):
        with self.assertRaisesRegex(AssertionError, 'cloud_playback_session_active'):
            self.run_idle('1\n')

    def test_zero_unexpired_cloud_sessions_allows_read_only_plan(self):
        self.assertIs(self.run_idle('0\n'), self.health)

    def test_unknown_cloud_count_fails_closed(self):
        for count in ('', 'unknown', '0\n1', '-1'):
            with self.subTest(count=count), self.assertRaisesRegex(
                    AssertionError, 'cloud_playback_session_active'):
                self.run_idle(count)

    def test_existing_local_busy_guard_remains_before_sql(self):
        self.health['rawPumpCount'] = 1
        with self.assertRaisesRegex(AssertionError, 'gateway_busy_or_unknown_rawPumpCount'):
            self.run_idle('0')


if __name__ == '__main__':
    unittest.main()
