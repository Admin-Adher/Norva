"""Read-only operator contract tests; imports do not access Docker, network or the DB."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/scripts/read-strict-lid-adaptive-evidence-proof-20260910.py'
spec = importlib.util.spec_from_file_location('adaptive_proof', SOURCE)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ReadOnlyProofTests(unittest.TestCase):
    def test_read_sql_enforces_read_only_and_internal_exact_identity(self):
        row = {'job': '11111111-1111-4111-8111-111111111111', 'user_id': '22222222-2222-4222-8222-222222222222',
               'fingerprint': 'a' * 64, 'identity_key': 'provider', 'external_id': 'file'}
        with patch.object(proof, 'run', return_value=b'{}') as command:
            proof.read_job(row)
        args, query, _timeout = command.call_args.args
        self.assertIn('PGOPTIONS=-c default_transaction_read_only=on', args)
        query = query.decode()
        self.assertIn('BEGIN READ ONLY', query)
        self.assertIn("SET LOCAL statement_timeout='10s'", query)
        self.assertIn('public.admin_internal_accounts', query)
        self.assertIn('j.profile_fingerprint=', query)
        self.assertIn('j.identity_key=', query)
        self.assertIn('j.requested_by=', query)
        self.assertIn('j.external_id=', query)
        for forbidden in ('UPDATE ', 'DELETE ', 'INSERT ', 'ALTER ', 'CREATE ', 'COMMIT;'):
            self.assertNotIn(forbidden, query)

    def test_no_job_means_no_db_call(self):
        with patch.object(proof, 'run', side_effect=AssertionError('unexpected operation')):
            self.assertIsNone(proof.read_job({}))

    def test_receipt_opening_uses_real_clock_and_original_authenticated_function(self):
        code = proof.RECEIPT_PROGRAM
        self.assertIn('checkpoint.openStrictLidWindowReceipt({', code)
        self.assertNotIn('nowMs:', code)
        self.assertNotIn('createDecipheriv(', code)
        self.assertNotIn('createStrictLidWindowReceipt(', code)
        self.assertIn("if(oldByDbAge)return {window:index+1,status:'expired',opened:false}", code)
        self.assertIn("error.code:'RECEIPT_UNAVAILABLE'", code)

    def test_actual_live_binding_and_sources_are_pinned(self):
        code = proof.RECEIPT_PROGRAM
        self.assertIn("functionText('strictLidWindowRuntimeBinding')", code)
        self.assertIn('Object.entries(input.sourceHashes)', code)
        self.assertIn("digest('/opt/whisper/model.sha256')", code)
        self.assertIn("digest('/opt/whisper/vad-bin.sha256')", code)
        self.assertIn('e.speechSamplerBinarySha256!==build.vadBinary', code)
        self.assertIn('resolveStrictLidConsensus(authenticatedEvidence,4)', code)

    def test_output_does_not_include_opaque_receipt_or_transcript_fields(self):
        code = proof.RECEIPT_PROGRAM
        output = code.split("return {window:index+1,status:'authenticated'", 1)[1].split('};', 1)[0]
        self.assertNotIn('receipt', output)
        self.assertNotIn('sample:', output)
        self.assertNotIn('text:', output)
        self.assertNotIn('shingles', output)
        self.assertNotIn('fingerprint', output)
        self.assertNotIn('userId', output)
        self.assertIn('speechMilliseconds', output)
        self.assertIn('language:r.language', output)

    def test_global_logs_are_explicitly_not_pilot_attribution(self):
        self.assertIn('whole-gateway-not-attributed-to-pilot', SOURCE.read_text())

    def test_timestamp_and_count_are_closed_types(self):
        self.assertIsNone(proof.timestamp('PRIVATE credential'))
        self.assertIsNone(proof.timestamp('2026-09-10T00:00:00'))
        self.assertEqual(proof.timestamp('2026-09-10T01:00:00Z'), '2026-09-10T01:00:00+00:00')
        self.assertIsNone(proof.count(True))
        self.assertIsNone(proof.count('12'))
        self.assertIsNone(proof.count(-1))
        self.assertEqual(proof.count(6, 6), 6)
        self.assertIsNone(proof.count(7, 6))


if __name__ == '__main__':
    unittest.main()
