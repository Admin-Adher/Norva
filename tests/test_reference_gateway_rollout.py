"""Exercise the actual complete-image rollout idle guard without Docker mutation."""
import importlib.util
import copy
import io
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'reference_rollout', pathlib.Path(__file__).resolve().parents[1]
    / 'ops/hetzner/media/rollout-reference-gateway.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ReferenceRolloutIdleTests(unittest.TestCase):
    def test_only_fully_persisted_deferred_storyboards_can_survive_idle_restart(self):
        original = {'Id': 'gateway', 'Config': {'Env': ['STORYBOARD_PRIVATE_DIR=/private']},
                    'Mounts': [{'Destination': '/private', 'RW': True}]}
        h = {'transcribeQueueDepth': 6, 'storyboardDurability': {'enabled': True, 'pending': 6},
             'languageForegroundWork': {'protocol': 1, 'busy': False, 'activeOperations': 0,
                 'admissionChecks': 0, 'pendingPriorityJobs': 0, 'deferredBackgroundJobs': 6}}
        with patch.object(r.subprocess, 'check_output', return_value='6\n'):
            self.assertTrue(r.deferred_storyboards_are_restartable(h, original))
            changed = copy.deepcopy(original); changed['Config']['Env'] = ['STORYBOARD_PRIVATE_DIR=/private/durable']
            self.assertTrue(r.deferred_storyboards_are_restartable(h, changed))
            for field in ('activeOperations', 'admissionChecks', 'pendingPriorityJobs'):
                changed = copy.deepcopy(h); changed['languageForegroundWork'][field] = 1
                self.assertFalse(r.deferred_storyboards_are_restartable(changed, original))
            changed = copy.deepcopy(h); del changed['languageForegroundWork']['activeOperations']
            self.assertFalse(r.deferred_storyboards_are_restartable(changed, original))
            changed = copy.deepcopy(original); changed['Mounts'] = []
            self.assertFalse(r.deferred_storyboards_are_restartable(h, changed))
        with patch.object(r.subprocess, 'check_output', return_value='5\n'):
            self.assertFalse(r.deferred_storyboards_are_restartable(h, original))

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

    def run_idle(self, count, table_exists='0', preparations='0', expected_version=None):
        results = iter((count, table_exists, preparations))
        with patch.object(r, 'inspect', return_value=self.original), \
                patch.object(r, 'health', side_effect=lambda name, original, debug=False:
                             {'sessions': []} if debug else self.health), \
                patch.object(r.subprocess, 'check_output', side_effect=lambda *args, **kwargs: next(results)) as query:
            try:
                return r.idle('norva-media-gateway', self.original,
                              expected_version=r.CURRENT_VERSION if expected_version is None else expected_version)
            finally:
                if query.called:
                    args = query.call_args_list[0].args[0]
                    self.assertEqual(args[:4], ['docker', 'exec', 'norva-db', 'psql'])
                    self.assertEqual(args[-2], '-c')
                    self.assertEqual(args[-1],
                        "select count(*) from cloud_playback_sessions where status in ('pending','ready') and expires_at>now();")
                    self.assertNotIn('playback_hint', args[-1])
                    if query.call_count > 1:
                        self.assertEqual(query.call_args_list[1].args[0][-1],
                            "select (to_regclass('public.live_playback_preparations') is not null)::int;")

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

    def test_rollback_can_check_target_170_independently_of_original_169(self):
        self.health.update(version=170, playbackPreparationPendingCount=0)
        with patch.object(r, 'CURRENT_VERSION', 169), patch.object(r, 'TARGET_VERSION', 170):
            self.assertIs(self.run_idle('0', expected_version=r.TARGET_VERSION), self.health)
            with self.assertRaisesRegex(AssertionError, 'unexpected_health'):
                self.run_idle('0', expected_version=r.CURRENT_VERSION)
            with self.assertRaisesRegex(AssertionError, 'cloud_playback_session_active'):
                self.run_idle('1', expected_version=r.TARGET_VERSION)

    def test_pending_or_unknown_preparation_resources_block_version_170(self):
        self.health['version'] = 170
        for value in (None, True, -1, 1):
            self.health['playbackPreparationPendingCount'] = value
            with self.subTest(value=value), self.assertRaisesRegex(AssertionError, 'playback_preparation_pending_or_unknown'):
                self.run_idle('0', expected_version=170)

    def test_preparation_table_absent_is_compatible_and_present_requires_zero(self):
        self.assertIs(self.run_idle('0', table_exists='0'), self.health)
        self.assertIs(self.run_idle('0', table_exists='1', preparations='0'), self.health)
        for value in ('1', 'unknown', '', '0\n1'):
            with self.subTest(value=value), self.assertRaisesRegex(AssertionError, 'live_playback_preparation_active'):
                self.run_idle('0', table_exists='1', preparations=value)
        with self.assertRaisesRegex(AssertionError, 'preparation_table_unknown'):
            self.run_idle('0', table_exists='unknown')

    def test_actual_preparation_predicate_blocks_live_attempts_drains_and_unacknowledged_cancellation(self):
        # Execute the operator's actual predicate, rather than copying it into
        # the test. Its SQL uses only these portable timestamp/state predicates.
        with sqlite3.connect(':memory:') as db:
            db.execute("attach database ':memory:' as public")
            db.execute('create table public.live_playback_preparations (state text, expires_at text, settled_at text)')
            db.create_function('now', 0, lambda: '2026-09-30T19:00:00Z')
            for state, future, settled, blocked in (
                ('prepared', True, False, True), ('prepared', False, False, False),
                ('creating', False, False, True), ('cancel_requested', False, False, True),
                ('creating', True, True, False), ('cancel_requested', True, True, True),
                ('cancel_requested', False, True, True),
                ('finished', True, True, False), ('cancelled', True, True, False)):
                db.execute('delete from public.live_playback_preparations')
                db.execute('insert into public.live_playback_preparations values (?,?,?)',
                    (state, '2026-10-01T00:00:00Z' if future else '2026-09-29T00:00:00Z',
                     '2026-09-30T18:00:00Z' if settled else None))
                queries = []
                def query(args, **kwargs):
                    sql = args[-1]; queries.append(sql)
                    if 'cloud_playback_sessions' in sql: return '0'
                    if 'to_regclass' in sql: return '1'
                    return str(db.execute(sql).fetchone()[0])
                with self.subTest(state=state, future=future, settled=settled), \
                        patch.object(r, 'inspect', return_value=self.original), \
                        patch.object(r, 'health', side_effect=lambda name, original, debug=False:
                                     {'sessions': []} if debug else self.health), \
                        patch.object(r.subprocess, 'check_output', side_effect=query):
                    if blocked:
                        with self.assertRaisesRegex(AssertionError, 'live_playback_preparation_active'):
                            r.idle('norva-media-gateway', self.original, expected_version=r.CURRENT_VERSION)
                    else:
                        self.assertIs(r.idle('norva-media-gateway', self.original, expected_version=r.CURRENT_VERSION), self.health)
                self.assertEqual(len(queries), 3)

    def test_real_operator_rolls_back_idle_170_candidate_to_169_after_failed_verification(self):
        base, image, revision = 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, 'c' * 40
        original = copy.deepcopy(self.original)
        original.update(Image=base, Name='/norva-media-gateway', State={'Running': True}, Mounts=[])
        containers = {original['Id']: original}
        actions = []
        def inspect(name):
            return next(value for value in containers.values() if name in (value['Id'], value['Name'].lstrip('/')))
        def docker(method, route, body=None):
            actions.append((method, route))
            if route == '/images/' + image + '/json': return {'Config': {'Labels': {'org.opencontainers.image.revision': revision}}}
            if route == '/containers/json?all=true': return [{'Id': key} for key in containers]
            if route.startswith('/containers/create?'):
                value = copy.deepcopy(original)
                value.update(Id='candidate', Image=image, State={'Running': False}, Name='/norva-media-gateway')
                value['Config'] = {key: val for key, val in body.items() if key not in ('HostConfig', 'NetworkingConfig')}
                value['HostConfig'] = body['HostConfig']
                containers['candidate'] = value
                return {'Id': 'candidate'}
            name = route.split('/')[2].split('?')[0]
            value = containers[name]
            if method == 'DELETE': del containers[name]; return
            if '/stop?' in route: value['State']['Running'] = False
            elif route.endswith('/start'): value['State']['Running'] = True
            elif '/rename?name=' in route: value['Name'] = '/' + route.split('name=')[1]
            else: self.fail('unexpected Docker operation ' + route)
        def health(name, _original, debug=False):
            if debug: return {'sessions': []}
            return {**self.health, 'version': 169 if inspect(name)['Image'] == base else 170,
                    'playbackPreparationPendingCount': 0}
        failure = RuntimeError('candidate health verification failed')
        argv = ['rollout', 'norva-media-gateway', '--apply', '--base-image', base,
                '--image', image, '--revision', revision, '--current-version', '169', '--target-version', '170']
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with patch('sys.argv', argv), patch('sys.stdout', new_callable=io.StringIO), \
                    patch.object(r.pathlib, 'Path', return_value=root), patch.object(r.os, 'umask'), \
                    patch.object(r, 'inspect', side_effect=inspect), patch.object(r, 'docker', side_effect=docker), \
                    patch.object(r, 'health', side_effect=health), patch.object(r, 'verify', side_effect=failure), \
                    patch.object(r.subprocess, 'check_output', return_value='0'), \
                    patch.object(r, 'BASE', base), patch.object(r, 'IMAGE', image), patch.object(r, 'REVISION', revision), \
                    patch.object(r, 'CURRENT_VERSION', 169), patch.object(r, 'TARGET_VERSION', 170):
                with self.assertRaisesRegex(RuntimeError, 'candidate health verification failed'):
                    r.main()
            receipt = json.loads(next(root.glob('*/result.json')).read_text())
            self.assertTrue(receipt['rolledBack'])
            self.assertNotIn('candidate', containers)
            self.assertEqual(original['Name'], '/norva-media-gateway')
            self.assertTrue(original['State']['Running'])
            self.assertEqual(original['Image'], base)
            self.assertIn(('DELETE', '/containers/candidate?force=true'), actions)


if __name__ == '__main__':
    unittest.main()
