'use strict';
// Explicitly authorized rollback-only SQL test over SSH, never a migration runner.
// Usage: node tests/fixtures/run-provider-audit-parity.cjs FIXTURE.sql user@host
const fs = require('node:fs'), { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const sqlFile = process.argv[2], target = process.argv[3];
assert.ok(sqlFile && target, 'Fixture path and explicit SSH target required');
assert.match(target, /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/, 'Invalid SSH destination');
const sql = fs.readFileSync(sqlFile, 'utf8');
assert.ok(Buffer.byteLength(sql) <= 10 * 1024 * 1024, 'Fixture exceeds 10 MiB');
assert.ok(/^-- ROLLBACK-ONLY PRIVATE FIXTURE:[^\n]*\nbegin;\n/.test(sql), 'Missing rollback-only fixture header');
assert.ok(/\nrollback;\n$/.test(sql), 'Missing final rollback');
assert.ok(/set local statement_timeout = '20s';/.test(sql), 'Missing 20-second statement timeout');
// END inside PL/pgSQL is a block terminator, not a transaction commit. Exclude
// dollar-quoted function/DO bodies only for the top-level transaction guard.
const topLevel = sql.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "'temporary-body'");
assert.ok(!/(?:^|\n)\s*(?:commit|end)\s*;/i.test(topLevel), 'Unsafe transaction terminator');
assert.ok(!/(?:^|\n)\s*commit\s*;/i.test(sql), 'Unsafe commit in fixture');
assert.ok(!/\b(?:create(?:\s+or\s+replace)?\s+function|alter\s+function|drop\s+function|update|delete\s+from|insert\s+into|alter\s+table|drop\s+table|create\s+table)\s+(?:only\s+)?public\./i.test(sql), 'Public mutation in fixture');
assert.ok(!/(?:^|\n)\s*(?:grant|revoke|execute|truncate|copy|call|dblink|lo_import|pg_read_file)\b/i.test(sql), 'Unsafe statement in fixture');
assert.ok(!/\bpublic\.(?:catalog_provider_|selection_provider_|cloud_)/i.test(sql), 'Unexpected public catalogue reference');
for (const write of sql.matchAll(/(?:^|\n)\s*(?:insert\s+into|update|delete\s+from)\s+([^\s(]+)/gi)) {
    assert.ok(write[1].startsWith('pg_temp.'), 'Non-temporary DML target');
}
const definitions = [...sql.matchAll(/\bcreate(?: or replace)? function ([a-z_.]+)/gi)];
assert.ok([4, 6].includes(definitions.length));
const allowed = new Set(['pg_temp.selection_provider_audio_language', 'pg_temp.catalog_provider_language_alias',
    'pg_temp.catalog_provider_dubbed_category', 'pg_temp.catalog_provider_language',
    'pg_temp.cloud_catalog_reconcile_provider_language_hints', 'pg_temp.cloud_catalog_effective_audio_languages']);
assert.ok(definitions.every(match => allowed.has(match[1])));
const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target,
    'docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) process.exitCode = result.status || 1;
