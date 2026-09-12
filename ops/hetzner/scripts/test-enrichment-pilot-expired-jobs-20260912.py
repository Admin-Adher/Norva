"""Offline runner regression: expired leases are due, not terminal resets."""
import ast
import collections
import json
import pathlib
import re
import sqlite3
import types
import unittest


SOURCE = pathlib.Path(__file__).with_name('run-enrichment-pilot20-20260911.py').read_text(encoding='utf8')
NOW = '2026-09-12T04:00:00Z'
BEFORE = '2026-09-12T03:59:59Z'
AFTER = '2026-09-12T04:00:01Z'


def require(value, code):
    if not value:
        raise RuntimeError(code)


class ExpiredJobTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.create_function('now', 0, lambda: NOW)
        self.db.execute('CREATE TABLE catalog_file_audio_validation_jobs '
            '(id TEXT, state TEXT, retry_at TEXT, lease_expires_at TEXT, '
            'quarantined_at TEXT, created_at TEXT, attempt_count INTEGER)')
        self.rows = []
        self.values = {}
        self.receipts = {}
        self.queries = []

        def query(sql):
            self.queries.append(sql)
            prefix = "SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM ("
            self.assertTrue(sql.startswith(prefix) and sql.endswith(')x;'))
            # Execute the actual SELECT's due-state predicate and ordering. Only
            # Postgres's output JSON wrapper, schema and UUID cast are adapted.
            select = sql[len(prefix):-3].replace('public.', '').replace('::uuid', '')
            return json.dumps([r[0] for r in self.db.execute(select)])

        self.ns = {'collections': collections, 'json': json, 're': re,
            'pilot': types.SimpleNamespace(current=lambda row: self.values[row['sample']],
                cache_result=lambda _: 'incomplete_tracks', track_unknown=lambda _: True,
                UUID=re.compile(r'[a-f0-9-]{36}')),
            'release': types.SimpleNamespace(stamp=lambda: NOW, require=require, sql=query,
                fleet=types.SimpleNamespace(literal=lambda value: "'"+value.replace("'", "''")+"'"))}
        fn = next(n for n in ast.parse(SOURCE).body if isinstance(n, ast.FunctionDef) and n.name == 'collect')
        exec(compile(ast.Module(body=[fn], type_ignores=[]), 'scoped-collect', 'exec'), self.ns)

    def add(self, state, *, lease=None, retry=None, quarantined=False, owned=True, intent=True):
        sample = len(self.rows)+1
        job_id = '00000000-0000-0000-0000-'+str(sample).zfill(12)
        self.rows.append({'sample': sample})
        self.receipts[str(sample)] = {'state': 'validating', 'probeAttempts': 1,
            **({'startIntentAt': BEFORE} if intent else {})}
        self.values[sample] = {'tracks': [], 'verified': False, 'job': {
            'id': job_id, 'state': state, 'owned': owned, 'quarantined': quarantined,
            'providerAttempts': 0, 'window': 0, 'errorCode': None}}
        self.db.execute('INSERT INTO catalog_file_audio_validation_jobs VALUES (?,?,?,?,?,?,?)',
            (job_id, state, retry, lease, BEFORE if quarantined else None, BEFORE, 5))
        return job_id

    def collect(self):
        state = {'rows': self.receipts}
        before = self.db.execute('SELECT * FROM catalog_file_audio_validation_jobs').fetchall()
        result = self.ns['collect']({'rows': self.rows}, state)
        self.assertEqual(before, self.db.execute('SELECT * FROM catalog_file_audio_validation_jobs').fetchall())
        self.assertTrue(all(r['probeAttempts'] == 1 for r in self.receipts.values()))
        return result

    def test_reclaims_same_expired_running_job_without_reset(self):
        job = self.add('running', lease=BEFORE)
        self.assertEqual(self.collect(), [job])

    def test_reclaims_expired_finalization_without_another_audio_job(self):
        job = self.add('finalizing', lease=BEFORE)
        self.assertEqual(self.collect(), [job])

    def test_lease_at_database_now_is_due(self):
        job = self.add('running', lease=NOW)
        self.assertEqual(self.collect(), [job])

    def test_live_and_missing_leases_are_not_due(self):
        self.add('running', lease=AFTER)
        self.add('finalizing', lease=AFTER)
        self.add('running')
        self.assertEqual(self.collect(), [])

    def test_terminal_quarantined_foreign_and_unowned_intent_jobs_are_not_reopened(self):
        for state in ('failed', 'expired', 'cancelled', 'verified', 'completed'):
            self.add(state, lease=BEFORE)
        self.add('running', lease=BEFORE, quarantined=True)
        self.add('running', lease=BEFORE, owned=False)
        self.add('running', lease=BEFORE, intent=False)
        self.assertEqual(self.collect(), [])

    def test_retry_wait_and_two_job_maximum_still_apply(self):
        self.add('retry_wait', retry=AFTER)
        first = self.add('running', lease=BEFORE)
        second = self.add('retry_wait', retry=BEFORE)
        self.add('queued')
        self.assertEqual(self.collect(), [first, second])
        self.assertIn('LIMIT 2', self.queries[-1])
        self.assertIn('quarantined_at IS NULL', self.queries[-1])


if __name__ == '__main__':
    unittest.main()
