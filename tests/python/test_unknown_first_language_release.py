"""No network/database: exercise release binding and control preservation."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

REPO = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('release', REPO/'ops/hetzner/scripts/deploy-unknown-first-language-pipeline.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.patch = patch.object(release, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        hashes = {}
        for name in release.MIGRATIONS:
            body = (REPO/'supabase/migrations'/name).read_bytes()
            (self.root/name).write_bytes(body)
            hashes[name] = hashlib.sha256(body).hexdigest()
        self.manifest = {'commit': 'a'*40, 'migrations': hashes}
        (self.root/'release-manifest.private.json').write_text(json.dumps(self.manifest))

    def test_exact_binding(self):
        self.assertEqual(release.bind(), self.manifest)
        with (self.root/release.MIGRATIONS[0]).open('ab') as f:
            f.write(b'-- unexpected')
        with self.assertRaisesRegex(RuntimeError, 'migration_hash_drift'):
            release.bind()

    def test_roles_match_existing_production_function_ownership(self):
        self.assertEqual(release.OWNERS['claim_catalog_vod_language_file(uuid,uuid)'], 'supabase_admin')
        self.assertEqual(release.OWNERS['cloud_catalog_effective_audio_languages(uuid,text,uuid,text)'], 'postgres')
        calls = []
        class Result:
            returncode = 0
            stdout = '1'
        def fake(args, **kwargs):
            calls.append(args)
            return Result()
        with patch.object(release.subprocess, 'run', side_effect=fake):
            release.query('select 1;', write=False)
            release.query('BEGIN; ROLLBACK;', write=True)
        self.assertEqual(calls[0][calls[0].index('-U')+1], 'postgres')
        self.assertEqual(calls[1][calls[1].index('-U')+1], 'supabase_admin')

    def test_scope_cannot_be_expanded(self):
        self.manifest['migrations']['other.sql'] = 'b'*64
        (self.root/'release-manifest.private.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(RuntimeError, 'migration_scope'):
            release.bind()

    def test_one_transaction_without_nested_commits(self):
        body = release.migration_sql()
        self.assertNotRegex(body, r'(?m)^(begin|commit);$')
        self.assertIn('norva_set_catalog_delete_proof', body)
        self.assertIn("values('owned_provider_language_metadata_enabled',false)", body)
        self.assertNotIn('cron.schedule(', body)

    def test_audit_artifacts_never_overwrite(self):
        release.save('proof.json', {'first': True})
        with self.assertRaises(FileExistsError):
            release.save('proof.json', {'first': False})
        self.assertEqual(release.read('proof.json'), {'first': True})

    def test_controls_stay_off_and_unchanged(self):
        before = {'flags': {'audio_lid_enabled': True}, 'cron': [{'id': 1, 'active': True}]}
        with patch.object(release, 'state', return_value={**before, 'metadataEnabled': False}):
            release.unchanged(before)
        with patch.object(release, 'state', return_value={**before, 'metadataEnabled': True}):
            with self.assertRaisesRegex(RuntimeError, 'metadata_must_stay_disabled'):
                release.unchanged(before)
        with patch.object(release, 'state', return_value={**before, 'metadataEnabled': False, 'cron': []}):
            with self.assertRaisesRegex(RuntimeError, 'runtime_controls_drift'):
                release.unchanged(before)


if __name__ == '__main__':
    unittest.main()
