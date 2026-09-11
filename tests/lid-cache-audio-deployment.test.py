"""Offline checks for the explicitly authorized combined release."""
import copy
import importlib.util
import pathlib
import re
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parents[1] / 'ops/hetzner/scripts/deploy-lid-cache-audio-20260911.py'
spec = importlib.util.spec_from_file_location('lid_cache_audio_release', SOURCE)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class CombinedReleaseGuards(unittest.TestCase):
    def documents(self):
        candidate = {'edge': 'e' * 64,
            'gateway': {'index.js': 'g' * 64, 'strict-lid-speech-sampler.js': 's' * 64},
            'migrations': dict(zip(operator.MIGRATIONS, ['a' * 64, 'b' * 64]))}
        result = {k: True for k in ('accepted', 'cacheReuseAfterImportPassed',
            'catalogLanguageReusePassed', 'languageFacetReusePassed', 'differentProviderExcluded',
            'noProviderOrGatewayRequests')}
        result['readOnlyCertificateGuards'] = {'passed': True, 'cases': [{}] * 12}
        imported = {'ok': True, 'removedOwnContainers': True, 'importReadOnlyProfileCase': True,
            'edgeIndexSha256': candidate['edge'], 'hydrationPatchSha256': 'a' * 64,
            'importProfileReadMigrationSha256': 'b' * 64, 'importHydration': result}
        def audio(count):
            return {'passed': True, 'externalProviderRequests': 0, 'originalClipUnchanged': True,
                'hashes': {'/app/src/' + k: v for k, v in candidate['gateway'].items()},
                'cases': [{'passed': True, 'gatewayIdle': True, 'providerActive': 0,
                           'remainingTemporaryFiles': []} for _ in range(count)]}
        return candidate, {'import-proof.json': imported, 'audio-proof.json': audio(3),
            'viewer-proof.json': audio(2),
            'node-proof.json': {'failed': 0, 'passed': 4250, 'candidate': copy.deepcopy(candidate)}}

    def test_exact_artifact_bindings_and_all_proof_families_are_mandatory(self):
        candidate, documents = self.documents()
        with patch.object(operator, 'document', side_effect=documents.__getitem__):
            operator.assert_fixture_binding(candidate)
        for name in documents:
            broken = copy.deepcopy(documents)
            broken[name] = {}
            with self.subTest(name=name), patch.object(operator, 'document', side_effect=broken.__getitem__):
                with self.assertRaises(RuntimeError):
                    operator.assert_fixture_binding(candidate)
        for key in candidate:
            changed = copy.deepcopy(candidate)
            if key == 'gateway':
                changed[key]['index.js'] = 'changed'
            elif key == 'migrations':
                changed[key][operator.MIGRATIONS[0]] = 'changed'
            else:
                changed[key] = 'changed'
            with patch.object(operator, 'document', side_effect=documents.__getitem__):
                with self.assertRaises(RuntimeError):
                    operator.assert_fixture_binding(changed)

    def test_both_sql_changes_have_only_one_outer_transaction(self):
        inputs = [(SOURCE.parents[3] / name).read_bytes().replace(b'\r\n', b'\n')
                  for name in operator.MIGRATIONS]
        sql = operator.atomic_migrations(inputs)
        self.assertEqual(len(re.findall(r'^BEGIN;$', sql, re.I | re.M)), 1)
        self.assertEqual(len(re.findall(r'^COMMIT;$', sql, re.I | re.M)), 1)
        self.assertTrue(sql.startswith('BEGIN;\n') and sql.endswith('\nCOMMIT;\n'))
        for raw in [b'SELECT 1;', b'BEGIN;\nBEGIN;\nCOMMIT;']:
            with self.assertRaises(RuntimeError):
                operator.atomic_migrations([raw])

    def test_scope_is_two_gateway_modules_two_migrations_and_one_edge_module(self):
        self.assertEqual(operator.gw.MODULES, ('index.js', 'strict-lid-speech-sampler.js'))
        self.assertEqual(len(operator.MIGRATIONS), 2)
        self.assertEqual(operator.EDGE_FILE, 'norva-playback/index.ts')
        source = SOURCE.read_text()
        for forbidden in ["'rm'", "'kill'", 'cron.unschedule', 'update public.admin_feature_flags']:
            self.assertNotIn(forbidden, source.lower())
        self.assertIn('speech_sampler_baseline_drift', source)
        self.assertIn('existingHydrationAttributesPreserved', source)
        self.assertIn('lid-cache-audio-rollback-20260911-1', source)

    def test_stage_never_stops_services_and_activation_keeps_viewer_priority(self):
        source = SOURCE.read_text()
        stage = source.split('def stage():', 1)[1].split('def hydration_attributes():', 1)[0]
        self.assertNotIn("docker_api(", stage)
        self.assertNotIn("'stop'", stage)
        self.assertIn("'--network', 'none'", stage)
        activate = source.split('def activate(name):', 1)[1].split('def verify():', 1)[0]
        self.assertGreaterEqual(activate.count('gw.assert_idle(gw.health())'), 2)
        self.assertIn('database_not_applied', activate)
        self.assertIn('gateway_not_deployed', activate)
        self.assertLess(activate.index('edge_health(inspect(other))'), activate.index("'stop'"))
        self.assertIn('restore(name, plan, deployment)', activate)


if __name__ == '__main__':
    unittest.main()
