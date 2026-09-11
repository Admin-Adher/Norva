"""Offline release guards; no Docker, network or production state is accessed."""
import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parents[1] / 'ops/hetzner/scripts/deploy-lid-cache-20260911.py'
spec = importlib.util.spec_from_file_location('lid_cache_release', SOURCE)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class ReleaseGuards(unittest.TestCase):
    def test_runtime_allowlist_is_two_js_modules_and_no_new_binary(self):
        self.assertEqual(operator.gw.MODULES, ('index.js', 'strict-lid-batch.js'))
        source = SOURCE.read_text()
        stage = source.split('def stage():', 1)[1].split('def database_checks():', 1)[0]
        self.assertNotIn('docker_api(', stage)
        self.assertNotIn("'stop'", stage)
        self.assertNotIn("'start'", stage)
        self.assertNotIn('COPY .', stage)
        self.assertIn("'--network', 'none'", stage)
        self.assertIn('gateway_base_image_not_physically_tested', stage)

    def test_edge_clone_changes_only_the_functions_mount(self):
        original = {'Config': {'Env': ['TEST=private'], 'Image': 'same-image'},
            'HostConfig': {'Binds': ['/old:/home/deno/functions:ro', '/cache:/cache:rw'], 'Memory': 512},
            'Mounts': [{'Destination': '/home/deno/functions', 'Source': '/old', 'RW': False},
                       {'Destination': '/cache', 'Source': '/cache', 'RW': True}]}
        snapshot = copy.deepcopy(original)
        with patch.object(operator, 'edge_root', return_value=pathlib.PurePosixPath('/old')):
            result = operator.edge_expected(original, pathlib.PurePosixPath('/new'))
        self.assertEqual(original, snapshot)
        self.assertEqual(result['Config'], original['Config'])
        self.assertEqual(result['HostConfig']['Binds'], ['/new:/home/deno/functions:ro', '/cache:/cache:rw'])
        self.assertEqual(result['HostConfig']['Memory'], 512)
        self.assertEqual(result['Mounts'][1], original['Mounts'][1])
        self.assertFalse(result['Mounts'][0]['RW'])

    def test_unexpected_or_writable_edge_bind_is_rejected(self):
        for binds in [[], ['/old:/home/deno/functions:rw'], ['/old:/home/deno/functions:ro'] * 2]:
            with patch.object(operator, 'edge_root', return_value=pathlib.PurePosixPath('/old')):
                with self.assertRaises(RuntimeError):
                    operator.edge_expected({'HostConfig': {'Binds': binds}}, pathlib.PurePosixPath('/new'))

    def proof(self):
        candidate = {'edge': 'e' * 64, 'migration': 'd' * 64,
                     'gateway': {'index.js': 'a' * 64, 'strict-lid-batch.js': 'b' * 64}}
        proof = {'acceptancePassed': True, 'physicalFileCase': True, 'removedOwnContainers': True,
                 'cacheHitsProviderRequests': 0, 'cacheHitsGatewayRequests': 0,
                 'cacheHits': [{}, {}], 'replacementDetected': True,
                 'edgeIndexSha256': candidate['edge'], 'candidateMigrationSha256': candidate['migration'],
                 'gatewayCandidateFiles': copy.deepcopy(candidate['gateway'])}
        return candidate, proof

    def test_physical_proof_must_bind_each_exact_artifact(self):
        candidate, proof = self.proof()
        with patch.object(operator, 'document', return_value=proof):
            operator.assert_fixture_binding(candidate)
        for key in proof:
            bad = copy.deepcopy(proof)
            bad.pop(key)
            with self.subTest(key=key), patch.object(operator, 'document', return_value=bad):
                with self.assertRaises(RuntimeError):
                    operator.assert_fixture_binding(candidate)
        for key in candidate:
            changed = copy.deepcopy(candidate)
            changed[key] = 'changed'
            with self.subTest(artifact=key), patch.object(operator, 'document', return_value=proof):
                with self.assertRaises(RuntimeError):
                    operator.assert_fixture_binding(changed)

    def test_activation_is_ordered_idle_gated_and_retains_rollback(self):
        source = SOURCE.read_text()
        activate = source.split('def activate(name):', 1)[1].split('def verify():', 1)[0]
        self.assertGreaterEqual(activate.count('gw.assert_idle(gw.health())'), 2)
        self.assertIn('database_not_applied', activate)
        self.assertIn('gateway_not_deployed', activate)
        self.assertLess(activate.index('edge_health(inspect(other))'), activate.index("'stop'"))
        self.assertLess(activate.index('restore(name, plan, deployment)'),
                        activate.index("raise RuntimeError('candidate_failed_original_restored')"))
        self.assertNotIn("'rm'", source)
        self.assertNotIn("'kill'", source)
        self.assertNotIn('cron.unschedule', source)
        self.assertNotIn('update public.admin_feature_flags', source.lower())


if __name__ == '__main__':
    unittest.main()
