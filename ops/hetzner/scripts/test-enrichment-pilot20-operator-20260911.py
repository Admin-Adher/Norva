"""Offline executable configuration tests; no production imports or I/O."""
import ast
import copy
import pathlib
import tempfile
import unittest

SOURCE=pathlib.Path(__file__).with_name('deploy-enrichment-pilot20-20260911.py').read_text(encoding='utf8')
tree=ast.parse(SOURCE)


def require(value,code):
    if not value:raise RuntimeError(code)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in
            ('mount_replace','environment','expected_container')]
        self.ns={'copy':copy,'ROOT':pathlib.PurePosixPath('/private/pilot20'),'require':require,
            'SERVICES':('gateway','edge1','edge2','selection')}
        exec(compile(ast.Module(body=selected,type_ignores=[]),'scoped-release-functions','exec'),self.ns)
        self.original={'Config':{'Env':['SECRET=untouched','SELECTION_AUDIO_CONCURRENCY=1']},
            'HostConfig':{'Binds':['/existing/runner:/worker/ops/hetzner/services:ro',
                '/existing/functions:/worker/supabase/functions:ro'],'Memory':1234},
            'Mounts':[{'Type':'bind','Source':'/existing/runner','Destination':'/worker/ops/hetzner/services','RW':False},
                {'Type':'bind','Source':'/existing/functions','Destination':'/worker/supabase/functions','RW':False}]}

    def test_selection_preserves_secret_resources_and_original(self):
        before=copy.deepcopy(self.original)
        plan={'containers':{'selection':self.original},'selectionMounts':{
            '/worker/ops/hetzner/services':'selection-live-runner','/worker/supabase/functions':'selection-live-functions'}}
        result=self.ns['expected_container'](plan,'selection')
        self.assertEqual(self.original,before)
        self.assertIn('SECRET=untouched',result['Config']['Env'])
        self.assertIn('SELECTION_CAPTURE_PIPELINE_ENABLED=0',result['Config']['Env'])
        self.assertIn('SELECTION_AUDIO_CONCURRENCY=1',result['Config']['Env'])
        self.assertEqual(result['HostConfig']['Memory'],1234)
        self.assertTrue(all(not m['RW'] for m in result['Mounts']))
        self.assertEqual(result['Mounts'][0]['Source'],'/private/pilot20/selection-live-runner')

    def test_gateway_adds_only_exact_private_volume_and_approved_env(self):
        before=copy.deepcopy(self.original)
        plan={'containers':{'gateway':self.original},'gatewayEnv':{'LANGUAGE_ENRICHMENT_ACTIVATION_MODE':'pilot'}}
        result=self.ns['expected_container'](plan,'gateway')
        self.assertEqual(self.original,before)
        self.assertEqual(result['Mounts'][-1]['Destination'],'/var/lib/norva-lid-private')
        self.assertEqual(result['Mounts'][-1]['Source'],'/private/pilot20/audio-private')
        self.assertEqual(len(result['Mounts']),len(before['Mounts'])+1)
        self.assertEqual(result['HostConfig']['Memory'],before['HostConfig']['Memory'])

    def test_missing_or_ambiguous_mount_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError,'mount_missing'):
            self.ns['mount_replace'](self.original,pathlib.Path('/new'),'/wrong')
        self.original['HostConfig']['Binds'].append(self.original['HostConfig']['Binds'][0])
        with self.assertRaisesRegex(RuntimeError,'mount_missing'):
            self.ns['mount_replace'](self.original,pathlib.Path('/new'),'/worker/ops/hetzner/services')

    def test_runner_cannot_dispatch_a_general_queue_request(self):
        runner=pathlib.Path(__file__).with_name('run-enrichment-pilot20-20260911.py').read_text(encoding='utf8')
        self.assertIn("json.dumps({'jobIds':ids})",runner)
        self.assertIn('len(ids)<=2',runner)
        self.assertIn("len(p['rows'])==20",runner)
        self.assertNotIn('UPDATE public.catalog_file_audio_validation_jobs',runner)
        self.assertNotIn('CREATE OR REPLACE',runner)


if __name__=='__main__':unittest.main()
