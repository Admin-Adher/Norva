"""Release-specific verification guards execute offline with no Docker access."""
import ast
import copy
import json
import pathlib
import re
import tempfile
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1]/'ops/hetzner/scripts/deploy-enrichment-admission-20260913.py'


def require(value, code):
    if not value:
        raise RuntimeError(code)


class AdmissionReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        functions = [node for node in ast.parse(SOURCE.read_text()).body if isinstance(node, ast.FunctionDef)]
        self.ns = {'ROOT':self.root, 'IMAGE':'candidate-image', 'pathlib':pathlib,
            'json':json, 'require':require, 're':re, 'sys':types.SimpleNamespace(argv=['release', 'stage', 'a'*40])}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), 'exec'), self.ns)
        self.health = {'ok':True, 'languageEnrichmentPilot':{'mode':'disabled', 'files':0, 'passiveSources':0},
            'languageForegroundWork':{'protocol':1, 'busy':False, 'activeOperations':0, 'admissionChecks':0,
                'pendingPriorityJobs':0, 'deferredBackgroundJobs':2}}
        self.current = {'Id':'new', 'Image':'base-image', 'State':{'Running':True, 'OOMKilled':False}, 'RestartCount':0}
        self.plan = {'original':{'Id':'old', 'Config':{'Image':'old-image'}}, 'imageIdentity':'new-image-digest',
            'originalImageIdentity':'old-image-digest', 'before':{'index.js':'old'}, 'after':{'index.js':'new'},
            'binaries':{}, 'runtime':{}}
        self.gw = types.SimpleNamespace(inspect=Mock(side_effect=lambda *_:self.current),
            assert_clone=Mock(), assert_container_image=Mock(), binary_snapshot=Mock(return_value={}),
            health=Mock(side_effect=lambda:self.health), assert_runtime=Mock(), assert_image_backed_runtime=Mock(), run=Mock())
        self.live = types.SimpleNamespace(source_snapshot=Mock(return_value=self.plan['after']), verify=Mock())
        self.ns.update(gw=self.gw, live=self.live, op=types.SimpleNamespace(SERVICE='gateway',
            saved=lambda name:{'candidateContainer':'new'}))

    def verify(self):
        self.ns['verify_gateway'](self.plan, True)

    def test_valid_diagnostic_and_exact_image_are_required(self):
        self.verify()
        self.gw.assert_clone.assert_called_once_with(self.plan['original'], self.current, 'candidate-image')
        self.gw.assert_container_image.assert_called_once_with(self.current, 'new-image-digest')

    def test_missing_diagnostic_is_not_accepted(self):
        del self.health['languageForegroundWork']
        with self.assertRaisesRegex(RuntimeError, 'foreground_activity_diagnostic_invalid'):
            self.verify()

    def test_work_counts_are_exact_nonnegative_integers(self):
        baseline=copy.deepcopy(self.health)
        for value in (-1, True, None, '1', 1.2):
            with self.subTest(value=value):
                self.health=copy.deepcopy(baseline)
                self.health['languageForegroundWork']['activeOperations']=value
                with self.assertRaisesRegex(RuntimeError, 'foreground_activity_diagnostic_invalid'):
                    self.verify()

    def test_deferred_work_can_be_idle_but_real_work_cannot(self):
        self.verify()
        self.health['languageForegroundWork']['activeOperations']=1
        with self.assertRaisesRegex(RuntimeError, 'foreground_activity_diagnostic_invalid'):
            self.verify()
        self.health['languageForegroundWork']['busy']=True
        self.verify()

    def test_diagnostic_cannot_leak_additional_fields(self):
        self.health['languageForegroundWork']['url']='private'
        with self.assertRaisesRegex(RuntimeError, 'foreground_activity_diagnostic_invalid'):
            self.verify()

    def test_unknown_container_and_source_drift_are_rejected(self):
        self.current['Id']='another-release'
        with self.assertRaisesRegex(RuntimeError, 'gateway_container_not_owned'):
            self.verify()
        self.current['Id']='new';self.live.source_snapshot.return_value={'index.js':'unexpected'}
        with self.assertRaisesRegex(RuntimeError, 'gateway_source_changed'):
            self.verify()

    def test_feature_activation_remains_forbidden(self):
        self.health['languageEnrichmentPilot']['mode']='fleet'
        with self.assertRaisesRegex(RuntimeError, 'dormant_admission_changed'):
            self.verify()

    def test_incomplete_or_foreign_native_proof_cannot_build_or_stage(self):
        valid={'exitCode':0, 'counts':{'tests':32,'pass':32,'fail':0,'skipped':0}, 'networkDisabled':True,
            'newProviderRequests':0, 'mediaOperations':0, 'abortedReason':None, 'image':'base-image'}
        for field,value in [('exitCode',1), ('counts',{}), ('networkDisabled',False), ('newProviderRequests',1),
            ('mediaOperations',1), ('abortedReason','viewer_started'), ('image','wrong-image')]:
            with self.subTest(field=field):
                proof={**valid,field:value}
                self.ns['NATIVE']=Mock(read_text=Mock(return_value=json.dumps(proof)))
                with self.assertRaisesRegex(RuntimeError, 'native_proof_mismatch'):
                    self.ns['stage']()
                self.gw.run.assert_not_called()
                self.assertFalse((self.root/'context').exists())
                self.assertFalse((self.root/'plan.private.json').exists())

    def test_release_reuses_idle_recovery_and_changes_only_one_module(self):
        source=SOURCE.read_text()
        self.assertIn("FILES = ('index.js',)", source)
        self.assertIn('deploy-scoped-passive-dormant-20260912.py', source)
        self.assertIn('op.invariant, op.verify_gateway = invariant, verify_gateway', source)
        self.assertIn('getattr(op, phase)()', source)
        self.assertIn("proof['sourceHashes'][name]", source)
        for forbidden in ('UPDATE public.', 'DELETE FROM', 'INSERT INTO public.', 'os.kill', 'rmtree(',
            'op.deploy =', 'op.recover =', 'op.run =', 'op.recovery_idle ='):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
