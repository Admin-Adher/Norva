"""Pure operator checks: no Docker, network, production or deployment is accessed."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/deploy-strict-lid-adaptive-evidence-20260910.py'
spec = importlib.util.spec_from_file_location('adaptive_deploy', SOURCE)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


def healthy():
    return {'ok': True, **{key: 0 for key in operator.IDLE_COUNTS},
            **{key: False for key in operator.IDLE_FLAGS}, 'languageWavExtraction': {'active': 0}}


def container():
    return {'Id': 'original-id', 'Config': {'Image': 'original-image', 'Env': ['PRIVATE=never-print'],
            'Labels': {'private': 'label'}, 'User': '1000'},
            'HostConfig': {'Binds': ['/private/cache:/app/cache'], 'OomKillDisable': None,
                           'Memory': 123, 'Devices': [{'PathOnHost': '/dev/dri/renderD128'}]},
            'NetworkSettings': {'Networks': {'norva_default': {'Aliases': ['gateway'],
                'IPAMConfig': None, 'Links': None, 'DriverOpts': None}}},
            'Mounts': [{'Type': 'bind', 'Source': '/private/cache', 'Destination': '/app/cache', 'RW': True}]}


class OperatorTests(unittest.TestCase):
    def test_import_has_no_operational_side_effects(self):
        self.assertTrue(callable(operator.stage_release))

    def test_module_allowlist_is_exact(self):
        self.assertEqual(set(operator.MODULES), {'index.js', 'strict-lid-inference.js',
            'strict-lid-window-checkpoint.js', 'strict-lid-audio-evidence.js',
            'strict-lid-speech-window.js', 'strict-lid-speech-sampler.js'})

    def test_idle_rejects_every_busy_or_missing_field(self):
        operator.assert_idle(healthy())
        for key in operator.IDLE_COUNTS + operator.IDLE_FLAGS:
            with self.subTest(key=key):
                missing = healthy()
                missing.pop(key)
                with self.assertRaises(RuntimeError):
                    operator.assert_idle(missing)
                busy = healthy()
                busy[key] = 1 if key in operator.IDLE_COUNTS else True
                with self.assertRaises(RuntimeError):
                    operator.assert_idle(busy)
        value = healthy()
        value['languageWavExtraction']['active'] = 1
        with self.assertRaises(RuntimeError):
            operator.assert_idle(value)

    def test_idle_counts_do_not_accept_boolean_false_as_zero(self):
        value = healthy()
        value['activeStrictLidBrokers'] = False
        with self.assertRaises(RuntimeError):
            operator.assert_idle(value)

    def test_clone_preserves_full_environment_host_network_and_mounts(self):
        before = container()
        after = copy.deepcopy(before)
        after['Config']['Image'] = 'candidate-image'
        after['HostConfig']['OomKillDisable'] = False
        operator.assert_clone(before, after, 'candidate-image')
        payload = operator.clone_payload(before, 'candidate-image')
        self.assertEqual(payload['Env'], before['Config']['Env'])
        self.assertEqual(payload['HostConfig'], before['HostConfig'])
        payload['Env'].append('MUTATION=must-not-affect-original')
        self.assertNotEqual(payload['Env'], before['Config']['Env'])
        for section in ('Config', 'HostConfig', 'Mounts', 'NetworkSettings'):
            changed = copy.deepcopy(after)
            if section == 'Config':
                changed['Config']['Env'] = []
            elif section == 'HostConfig':
                changed['HostConfig']['Memory'] = 456
            elif section == 'Mounts':
                changed['Mounts'][0]['Source'] = '/other/cache'
            else:
                changed['NetworkSettings']['Networks']['norva_default']['Aliases'] = []
            with self.assertRaises(RuntimeError):
                operator.assert_clone(before, changed, 'candidate-image')

    def artifact_stage(self, directory):
        stage = pathlib.Path(directory)
        for name in ('base', 'src', 'bin'):
            (stage / name).mkdir()
        for name in operator.EXISTING_MODULES:
            (stage / 'base' / name).write_bytes(b'base\r\n')
        for name in operator.MODULES:
            (stage / 'src' / name).write_bytes(b'// candidate\r\n')
        binary = b'\x7fELF-independent-binary-fixture'
        digest = hashlib.sha256(binary).hexdigest()
        (stage / 'bin/whisper-vad-speech-segments').write_bytes(binary)
        (stage / 'bin/vad-bin.sha256').write_text(digest + '\n')
        # These must never be included in Docker's context.
        (stage / 'private-source.wav').write_bytes(b'private audio')
        (stage / 'secret.env').write_text('PASSWORD=private')
        (stage / 'original-inspect.private.json').write_text('{"Env":["private"]}')
        return stage, digest

    def test_context_contains_only_allowed_artifacts_and_no_secret_or_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage, digest = self.artifact_stage(temporary)
            with patch.object(operator, 'EXPECTED_BASE_INDEX_SHA', operator.sha(b'base\n', True)):
                context, sources, base, digest_sha = operator.prepare_context(stage, digest)
            actual = {path.relative_to(context).as_posix() for path in context.rglob('*') if path.is_file()}
            expected = {'src/' + name for name in operator.MODULES} | {
                'Dockerfile', 'whisper-vad-speech-segments', 'vad-bin.sha256'}
            self.assertEqual(actual, expected)
            self.assertEqual(len(sources), 6)
            self.assertEqual(len(base), 3)
            self.assertEqual(digest_sha, operator.sha((stage / 'bin/vad-bin.sha256').read_bytes()))
            dockerfile = (context / 'Dockerfile').read_text()
            self.assertEqual(dockerfile.count('COPY '), 8)
            self.assertNotIn('COPY .', dockerfile)
            self.assertNotIn('ENV ', dockerfile)
            self.assertNotIn('RUN ', dockerfile)
            self.assertIn('COPY --chmod=0755 whisper-vad-speech-segments', dockerfile)
            self.assertEqual(dockerfile.count('COPY --chmod=0644'), 7)
            with self.assertRaises(RuntimeError):
                operator.prepare_context(stage, digest)

    def test_binary_and_independently_provided_digest_must_all_agree(self):
        for mutation in ('argument', 'file', 'elf'):
            with tempfile.TemporaryDirectory() as temporary:
                stage, digest = self.artifact_stage(temporary)
                if mutation == 'argument':
                    digest = 'a' * 64
                elif mutation == 'file':
                    (stage / 'bin/vad-bin.sha256').write_text('b' * 64)
                else:
                    (stage / 'bin/whisper-vad-speech-segments').write_bytes(b'not-an-elf')
                with self.assertRaises(RuntimeError):
                    operator.prepare_context(stage, digest)
                self.assertFalse((stage / 'build-context').exists())

    def test_private_plan_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'plan.json'
            operator.private_write(path, {'original': True})
            with self.assertRaises(FileExistsError):
                operator.private_write(path, {'original': False})
            self.assertEqual(json.loads(path.read_text()), {'original': True})

    def test_runtime_requires_existing_digests_and_new_sampler_health_proof(self):
        engine = {key: 'stable' for key in operator.RUNTIME_FIELDS}
        engine.update({'runtimeVerified': True, 'vadRuntimeVerified': True,
                       'binarySha256': 'a' * 64, 'modelSha256': 'b' * 64, 'vadModelSha256': 'c' * 64})
        value = {'languageDetectEngine': engine}
        baseline = operator.runtime_snapshot(value)
        with self.assertRaises(RuntimeError):
            operator.assert_runtime(value, baseline, 'd' * 64)
        value['languageDetectEngine'].update({'speechSamplerRuntimeVerified': True,
                                             'speechSamplerBinarySha256': 'd' * 64})
        value['languageDetectEngine']['strictLidSpeechSelectionProtocol'] = 1
        operator.assert_runtime(value, baseline, 'd' * 64)
        value['languageDetectEngine']['binarySha256'] = 'e' * 64
        with self.assertRaises(RuntimeError):
            operator.assert_runtime(value, baseline, 'd' * 64)

    def test_real_vad_validation_is_bound_to_exact_image_binary_and_all_cases(self):
        plan = {'imageIdentity': {'index': 'image-index', 'manifest': 'platform-manifest'}, 'vadSha256': 'a' * 64}
        proof = {'protocol': 1, 'candidateImageIdentity': plan['imageIdentity'], 'vadSha256': plan['vadSha256'],
                 'networkDisabled': True, 'speechCasePassed': True, 'silenceCasePassed': True, 'shortCasePassed': True}
        with tempfile.TemporaryDirectory() as temporary:
            stage = pathlib.Path(temporary)
            path = stage / 'vad-validation.private.json'
            path.write_text(json.dumps(proof))
            operator.assert_vad_validation(stage, plan)
            for key in proof:
                broken = copy.deepcopy(proof)
                broken.pop(key)
                path.write_text(json.dumps(broken))
                with self.assertRaises(RuntimeError):
                    operator.assert_vad_validation(stage, plan)
            broken = copy.deepcopy(proof)
            broken['candidateImageIdentity']['manifest'] = 'another-manifest'
            path.write_text(json.dumps(broken))
            with self.assertRaises(RuntimeError):
                operator.assert_vad_validation(stage, plan)

    def test_stage_does_not_create_or_start_service_clone(self):
        source = SOURCE.read_text()
        stage_body = source.split('def stage_release(', 1)[1].split('def readiness(', 1)[0]
        self.assertNotIn('docker_api(', stage_body)
        self.assertNotIn("'start'", stage_body)
        self.assertNotIn("'stop'", stage_body)
        self.assertIn("'--network', 'none'", stage_body)
        self.assertIn("'--read-only'", stage_body)

    def test_deploy_failure_restores_original_before_reporting_failure(self):
        source = SOURCE.read_text()
        section = source.split('def deploy_release(', 1)[1].split('def main(', 1)[0]
        exception_path = section.split('except Exception:', 1)[1]
        self.assertLess(exception_path.index('restore_original(plan, deployment)'),
                        exception_path.index('verify_active(plan, original, False)'))
        self.assertLess(exception_path.index('verify_active(plan, original, False)'),
                        exception_path.index("raise RuntimeError('candidate_failed_original_restored')"))
        self.assertNotIn("'rm'", section)
        self.assertNotIn("'kill'", section)
        self.assertGreaterEqual(section.count('assert_idle(health())'), 3)


if __name__ == '__main__':
    unittest.main()
