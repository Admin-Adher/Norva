"""Offline operator tests. Never opens a database, manifest URL or secret file."""
import copy
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py'
SPEC = importlib.util.spec_from_file_location('selection_filename_refresh', PATH)
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)


def state(applied=False):
    row = {
        'variant_id': operator.VARIANT,
        'media_item_id': '10000000-0000-4000-8000-000000000001',
        'user_id': '20000000-0000-4000-8000-000000000002',
        'source_id': '30000000-0000-4000-8000-000000000003',
        'title_id': '40000000-0000-4000-8000-000000000004',
        'generation_id': '50000000-0000-4000-8000-000000000005',
        'snapshot': {
            'generationId': '50000000-0000-4000-8000-000000000005',
            'headRevision': 8, 'configRevision': 7, 'sourceVisibilityEpoch': 4,
            'userVisibilityEpoch': 13 if applied else 12, 'isCatalogVisible': True,
        },
        'guards_enabled': True, 'external_id': operator.EXTERNAL,
        'media_external_id': operator.EXTERNAL, 'matches_spanish': applied, 'matches_unidentified': not applied,
    }
    for prefix in ('variant', 'media'):
        row.update({
            prefix + '_selection_id': operator.IDENTITY,
            prefix + '_feed': operator.FEED,
            prefix + '_revision': operator.REVISION,
            prefix + '_validation_hash': operator.URL_HASH,
            prefix + '_target_hash': operator.URL_HASH,
            prefix + '_metadata_hash': ('b' if applied else 'a') * 64,
            prefix + '_declaration': copy.deepcopy(operator.DECLARATION) if applied else None,
        })
    return row


RESULT = {'updated': True, 'media_rows': 1, 'variant_rows': 1,
          'language': 'es', 'observations_unchanged': True, 'provider_requests': 0}


class FakeDatabase:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def execute(self, sql, readonly=False):
        self.calls.append((sql, readonly))
        if not self.responses:
            raise AssertionError('unexpected_database_call')
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)


class OperatorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def save_plan(self, before=None, **overrides):
        plan = {'prepared_at': time.time(), 'expires_at': time.time() + 1800,
                'operator_sha256': operator.operator_hash(), 'before': before or state()}
        plan.update(overrides)
        operator.private_write(self.root / 'plan.private.json', plan)
        return plan

    def save_dry_run(self, before=None, **overrides):
        dry = {'at': time.time(), 'result': RESULT,
               'operator_sha256': operator.operator_hash(), 'before': before or state()}
        dry.update(overrides)
        operator.private_write(self.root / 'dry-run.private.json', dry)

    def test_state_read_is_bounded_readonly_and_hash_only(self):
        db = FakeDatabase([state()])
        self.assertEqual(operator.read_state(db), state())
        sql, readonly = db.calls[0]
        self.assertTrue(readonly)
        self.assertIn("statement_timeout='20s'", sql)
        self.assertIn('BEGIN READ ONLY', sql)
        self.assertIn("SET LOCAL ROLE service_role", sql)
        self.assertTrue(sql.endswith('ROLLBACK;'))
        self.assertIn(operator.VARIANT, sql)
        self.assertIn('m.generation_id=v.generation_id', sql)
        for line in sql.splitlines():
            if "targetUrl" in line:
                self.assertIn('sha256(convert_to(', line)
        self.assertNotIn('codec_profile', sql)

    def test_no_zero_multiple_or_changed_variant_identity(self):
        for rows in ([], [state(), state()], None, {'row': state()}):
            with self.subTest(rows=type(rows)), self.assertRaisesRegex(RuntimeError, 'exact_visible_variant_missing'):
                operator.read_state(FakeDatabase(rows))
        for key in ('variant_id', 'external_id', 'media_external_id'):
            row = state()
            row[key] = '60000000-0000-4000-8000-000000000006' if key == 'variant_id' else 'changed'
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'file_identity_changed'):
                operator.read_state(FakeDatabase([row]))
        for key in ('variant_id', 'media_item_id', 'user_id', 'source_id', 'title_id', 'generation_id'):
            row = state()
            row[key] = "x'; DROP TABLE forbidden;--"
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'invalid_identity'):
                operator.read_state(FakeDatabase([row]))

    def test_both_manifest_hashes_and_metadata_hashes_are_required(self):
        cases = {
            '_selection_id': ('changed', 'selection_identity_changed'),
            '_feed': ('different-feed', 'manifest_scope_changed'),
            '_revision': ('stale-revision', 'manifest_scope_changed'),
            '_validation_hash': ('c' * 64, 'url_hash_changed'),
            '_target_hash': (None, 'url_hash_changed'),
            '_metadata_hash': ('incomplete', 'invalid_metadata_hash'),
            '_declaration': ({'version': 1, 'language': 'en'}, 'existing_declaration_conflict'),
        }
        for prefix in ('variant', 'media'):
            for suffix, (value, code) in cases.items():
                row = state()
                row[prefix + suffix] = value
                with self.subTest(key=prefix + suffix), self.assertRaisesRegex(RuntimeError, code):
                    operator.read_state(FakeDatabase([row]))

    def test_guards_visibility_snapshot_and_epochs_fail_closed(self):
        for key, value, code in (
            ('isCatalogVisible', False, 'generation_not_visible'),
            ('generationId', '60000000-0000-4000-8000-000000000006', 'generation_not_visible'),
            ('headRevision', -1, 'invalid_write_snapshot'),
            ('configRevision', None, 'invalid_write_snapshot'),
            ('sourceVisibilityEpoch', True, 'invalid_write_snapshot'),
            ('userVisibilityEpoch', '12', 'invalid_write_snapshot'),
        ):
            row = state()
            row['snapshot'][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, code):
                operator.read_state(FakeDatabase([row]))
        row = state()
        row['guards_enabled'] = False
        with self.assertRaisesRegex(RuntimeError, 'writer_guards_missing'):
            operator.read_state(FakeDatabase([row]))

    def test_prepare_saves_single_expiring_hash_bound_plan_and_never_writes_db(self):
        db = FakeDatabase([state()])
        self.assertEqual(operator.prepare(self.root, db), {'prepared': True, 'variants': 1, 'provider_requests': 0})
        plan = operator.load_plan(self.root)
        self.assertEqual(plan['before'], state())
        self.assertLessEqual(plan['expires_at'] - plan['prepared_at'], 1801)
        self.assertTrue(all(readonly for _, readonly in db.calls))
        with self.assertRaisesRegex(RuntimeError, 'plan_already_exists'):
            operator.prepare(self.root, FakeDatabase())

    def test_prepare_already_applied_is_readonly_but_partial_or_bad_projection_stops(self):
        self.assertTrue(operator.prepare(self.root, FakeDatabase([state(True)]))['already_applied'])
        self.assertFalse((self.root / 'plan.private.json').exists())
        partial = state()
        partial['media_declaration'] = operator.DECLARATION
        with self.assertRaisesRegex(RuntimeError, 'partial_declaration_requires_review'):
            operator.prepare(self.root, FakeDatabase([partial]))
        inconsistent = state(True)
        inconsistent['matches_spanish'] = False
        with self.assertRaisesRegex(RuntimeError, 'existing_projection_inconsistent'):
            operator.prepare(self.root, FakeDatabase([inconsistent]))

    def test_plan_expiry_and_operator_identity_are_enforced(self):
        self.save_plan(expires_at=100)
        with self.assertRaisesRegex(RuntimeError, 'plan_expired'):
            operator.load_plan(self.root, now=100)
        with patch.object(operator, 'operator_hash', return_value='changed'):
            with self.assertRaisesRegex(RuntimeError, 'operator_changed'):
                operator.load_plan(self.root, now=99)

    def test_existing_identified_audio_is_not_silently_relabelled(self):
        row = state()
        row['matches_unidentified'] = False
        with self.assertRaisesRegex(RuntimeError, 'variant_already_identified_requires_review'):
            operator.prepare(self.root, FakeDatabase([row]))
        self.assertFalse((self.root / 'plan.private.json').exists())

    def test_result_requires_exact_counts_no_observation_change_and_no_provider_requests(self):
        self.assertTrue(operator.valid_result(RESULT))
        for key, value in (('updated', 1), ('media_rows', 2), ('variant_rows', True),
                           ('language', 'en'), ('observations_unchanged', False), ('provider_requests', 1)):
            result = dict(RESULT, **{key: value})
            with self.subTest(key=key):
                self.assertFalse(operator.valid_result(result))
        self.assertFalse(operator.valid_result(None))

    def test_dry_run_runs_same_guarded_sql_then_rolls_back_and_rereads(self):
        self.save_plan()
        db = FakeDatabase([state()], RESULT, [state()])
        self.assertEqual(operator.run_change(self.root, db), {'dry_run_passed': True, 'persisted_rows': 0})
        self.assertEqual([readonly for _, readonly in db.calls], [True, False, True])
        self.assertTrue(db.calls[1][0].rstrip().endswith('ROLLBACK;'))
        self.assertNotIn('COMMIT;', db.calls[1][0])
        receipt = json.loads((self.root / 'dry-run.private.json').read_text())
        self.assertEqual(receipt['before'], state())
        self.assertFalse((self.root / 'apply-intent.private.json').exists())

    def test_dry_run_cannot_claim_success_after_changed_state_or_rollback_failure(self):
        self.save_plan()
        changed = state()
        changed['variant_metadata_hash'] = 'c' * 64
        with self.assertRaisesRegex(RuntimeError, 'prepared_state_changed'):
            operator.run_change(self.root, FakeDatabase([changed]))
        with self.assertRaisesRegex(RuntimeError, 'dry_run_did_not_rollback'):
            operator.run_change(self.root, FakeDatabase([state()], RESULT, [state(True)]))
        self.assertFalse((self.root / 'dry-run.private.json').exists())

    def test_apply_requires_explicit_ack_and_matching_successful_dry_run(self):
        self.save_plan()
        with self.assertRaisesRegex(RuntimeError, 'explicit_apply_ack_required'):
            operator.run_change(self.root, FakeDatabase([state()]), True)
        self.assertFalse((self.root / 'apply-intent.private.json').exists())
        self.save_dry_run(operator_sha256='stale')
        with self.assertRaisesRegex(RuntimeError, 'dry_run_missing_or_changed'):
            operator.run_change(self.root, FakeDatabase([state()]), True, operator.ACK)
        self.assertFalse((self.root / 'apply-intent.private.json').exists())

    def test_apply_commits_once_only_after_immutable_intent_and_then_verifies(self):
        self.save_plan()
        self.save_dry_run()
        root = self.root

        class IntentCheckingDatabase(FakeDatabase):
            def execute(self, sql, readonly=False):
                if not readonly:
                    if not (root / 'apply-intent.private.json').exists():
                        raise AssertionError('intent_must_precede_write')
                return super().execute(sql, readonly)

        db = IntentCheckingDatabase([state()], RESULT, [state(True)])
        self.assertEqual(operator.run_change(self.root, db, True, operator.ACK),
                         {'applied': True, 'variants': 1, 'language': 'es', 'provider_requests': 0})
        self.assertTrue(db.calls[1][0].rstrip().endswith('COMMIT;'))
        self.assertTrue((self.root / 'applied.private.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'prior_apply_intent_no_retry'):
            operator.run_change(self.root, FakeDatabase(), True, operator.ACK)

    def test_uncertain_apply_or_postcondition_failure_never_retries(self):
        self.save_plan()
        self.save_dry_run()
        db = FakeDatabase([state()], RuntimeError('a possibly committed timeout'))
        with self.assertRaisesRegex(RuntimeError, 'apply_uncertain_no_retry'):
            operator.run_change(self.root, db, True, operator.ACK)
        self.assertEqual(len(db.calls), 2)
        self.assertTrue((self.root / 'uncertain.private.json').exists())
        self.assertFalse((self.root / 'applied.private.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'prior_apply_intent_no_retry'):
            operator.run_change(self.root, FakeDatabase(), False)

    def test_private_receipts_are_never_overwritten(self):
        path = self.root / 'receipt.json'
        operator.private_write(path, {'original': True})
        with self.assertRaises(FileExistsError):
            operator.private_write(path, {'original': False})
        self.assertEqual(json.loads(path.read_text()), {'original': True})

    def test_generated_sql_uses_existing_service_role_fences_without_bypass(self):
        sql = operator.apply_sql({'before': state()})
        for required in (
            'SECURITY DEFINER SET search_path', 'norva_credential_require_service_role()',
            'norva_credential_lock_account', 'norva_get_catalog_write_snapshot',
            'norva_set_catalog_delete_proof', 'write_snapshot_cas_failed',
            'metadata_cas_failed', 'manifest_hash_cas_failed', 'exact_identity_cas_failed',
            "session_replication_role')='origin'", 'writer_guards_missing',
            'REVOKE ALL ON FUNCTION pg_temp.', 'FROM public,anon,authenticated',
            'SET LOCAL ROLE service_role', 'variant_no_longer_visible',
            'observation_after is distinct from observation_before',
            'cloud_catalog_effective_audio_languages', 'cloud_catalog_unidentified_audio_variants',
            'media_count<>1', 'variant_count<>1', 'unrelated_metadata_changed',
            "to_jsonb(media)-array['metadata','updated_at'", "to_jsonb(variant)-array['metadata','updated_at'",
        ):
            with self.subTest(required=required):
                self.assertIn(required, sql)
        for field in ('write_head_revision', 'write_config_revision', 'write_source_visibility_epoch', 'write_user_visibility_epoch'):
            self.assertEqual(sql.count(field + '=(snapshot'), 2)
        self.assertEqual(sql.count('perform public.norva_bump_user_catalog_visibility_epoch('), 1)
        self.assertLess(sql.index('norva_credential_lock_account('), sql.index('for share of h,l'))
        self.assertLess(sql.index('for share of h,l'), sql.index('where e.user_id='))
        self.assertLess(sql.index('manifest_hash_cas_failed'), sql.index('update public.cloud_media_items'))
        for forbidden in ('disable trigger', "session_replication_role=", 'set_config(', 'audio_lang_verified_at=',
                          'update public.cloud_title_file_language_observations', 'delete from ', 'truncate ',
                          'http://', 'https://', 'codec_profile='):
            self.assertNotIn(forbidden, sql.lower())


class DockerAdapterTest(unittest.TestCase):
    def test_shell_free_readonly_psql_adapter_does_not_read_credentials(self):
        response = types.SimpleNamespace(returncode=0, stdout='[{}]\n', stderr='')
        with patch.object(operator.subprocess, 'run', return_value=response) as run:
            self.assertEqual(operator.DockerDatabase().execute('SELECT safe;', True), [{}])
        args = run.call_args.args[0]
        self.assertIn('PGOPTIONS=-c default_transaction_read_only=on', args)
        self.assertIn('-X', args)
        self.assertEqual(run.call_args.kwargs['input'], 'SELECT safe;')
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertEqual(run.call_count, 1)
        for name in ('bad container', 'x; rm anything', '', 'x' * 81):
            with self.assertRaisesRegex(RuntimeError, 'invalid_container'):
                operator.DockerDatabase(name)

    def test_errors_are_redacted_and_never_auto_retried(self):
        responses = [types.SimpleNamespace(returncode=1, stdout='', stderr='secret-url-from-database'),
                     types.SimpleNamespace(returncode=0, stdout='secret-url-not-json', stderr='')]
        for response in responses:
            with patch.object(operator.subprocess, 'run', return_value=response) as run:
                with self.assertRaisesRegex(RuntimeError, '^database_(failed_or_uncertain|response_uncertain)$'):
                    operator.DockerDatabase().execute('SELECT safe;')
                self.assertEqual(run.call_count, 1)
        with patch.object(operator.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 35)) as run:
            with self.assertRaisesRegex(RuntimeError, '^database_failed_or_uncertain$'):
                operator.DockerDatabase().execute('SELECT safe;')
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
