'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const walSync = read('ops/hetzner/backup/wal-sync.sh');
const walPrune = read('ops/hetzner/backup/wal-prune-r2.sh');
const capacityCheck = read('ops/hetzner/backup/capacity-check.sh');
const timerInstaller = read('ops/hetzner/backup/install-timers.sh');
const reindexMonthly = read('ops/hetzner/backup/reindex-monthly.sh');
const proofGc = read('ops/hetzner/backup/proof-gc.sh');
const dockerGc = read('ops/hetzner/backup/docker-gc.sh');
const storageWatch = read('ops/hetzner/backup/storage-watch.sh');

function bashBinary() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  return fs.existsSync(gitBash) ? gitBash : null;
}

function toBashPath(value) {
  if (process.platform !== 'win32') return value;
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
  try { fs.chmodSync(filePath, 0o755); } catch (_) { /* Windows ignores POSIX mode. */ }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-wal-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const archive = path.join(dir, 'archive');
  const opsDir = path.join(dir, 'ops');
  const mockBin = path.join(dir, 'bin');
  fs.mkdirSync(archive);
  fs.mkdirSync(opsDir);
  fs.mkdirSync(mockBin);
  fs.writeFileSync(path.join(opsDir, '.env'), 'POSTGRES_PASSWORD=test-only\n');

  const envFile = path.join(dir, 'norva-backup.env');
  const remoteList = path.join(dir, 'remote.list');
  const rcloneLog = path.join(dir, 'rclone.log');
  const stateFile = path.join(dir, 'capacity.state');
  const lockFile = path.join(dir, 'wal.lock');
  fs.writeFileSync(remoteList, '');
  fs.writeFileSync(rcloneLog, '');
  fs.writeFileSync(envFile, [
    'R2_ACCOUNT_ID=test',
    'R2_ACCESS_KEY_ID=test',
    'R2_SECRET_ACCESS_KEY=test',
    'R2_BUCKET=test-bucket',
    'R2_PREFIX_WAL=selfhost/wal',
    `NORVA_OPS_DIR=${toBashPath(opsDir)}`,
    `WAL_ARCHIVE_DIR=${toBashPath(archive)}`,
    `WAL_R2_LOCK_FILE=${toBashPath(lockFile)}`,
    `CAPACITY_STATE_FILE=${toBashPath(stateFile)}`,
    'CAPACITY_UNIT_CHECKS=norva-wal-sync:1',
    'CAPACITY_WAL_WARN_GIB=9999',
    'CAPACITY_TITLE_WARN_BYTES=999999',
    'CAPACITY_DISK_WARN_PCT=99',
    'KEEP_LOCAL_WAL_MINUTES=60',
    'PG_IMAGE=test-image'
  ].join('\n') + '\n');

  writeExecutable(path.join(mockBin, 'flock'), '#!/usr/bin/env bash\nexit "${FLOCK_TEST_EXIT:-0}"\n');
  writeExecutable(path.join(mockBin, 'rclone'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RCLONE_TEST_LOG"
case "$1" in
  copy) exit "${'${RCLONE_COPY_EXIT:-0}'}" ;;
  lsf) cat "$RCLONE_TEST_REMOTE_LIST"; exit "${'${RCLONE_LSF_EXIT:-0}'}" ;;
  delete) exit 0 ;;
  *) exit 90 ;;
esac
`);

  return { dir, archive, opsDir, mockBin, envFile, remoteList, rcloneLog, stateFile };
}

function runBash(scriptPath, fx, extraEnv = {}) {
  const bash = bashBinary();
  if (!bash) return null;
  const command = [
    `export PATH=${shellQuote(toBashPath(fx.mockBin))}:$PATH`,
    `export NORVA_BACKUP_ENV=${shellQuote(toBashPath(fx.envFile))}`,
    `export RCLONE_TEST_REMOTE_LIST=${shellQuote(toBashPath(fx.remoteList))}`,
    `export RCLONE_TEST_LOG=${shellQuote(toBashPath(fx.rcloneLog))}`,
    ...Object.entries(extraEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    shellQuote(toBashPath(scriptPath))
  ].join('; ');
  return spawnSync(bash, ['-c', command], { cwd: root, encoding: 'utf8' });
}

function makeOld(filePath, minutes = 120) {
  fs.writeFileSync(filePath, 'wal');
  const when = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(filePath, when, when);
}

test('WAL sync uses one bounded R2 inventory and deletes only proven remote files', (t) => {
  const fx = fixture(t);
  const names = [
    '000000010000000000000001',
    '000000010000000000000002',
    '000000010000000000000003'
  ];
  names.forEach((name) => makeOld(path.join(fx.archive, name)));
  fs.writeFileSync(fx.remoteList, `${names[0]}\n${names[1]}\n`);

  const result = runBash(path.join(root, 'ops/hetzner/backup/wal-sync.sh'), fx);
  if (!result) return t.skip('bash unavailable');

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(fx.archive, names[0])), false);
  assert.equal(fs.existsSync(path.join(fx.archive, names[1])), false);
  assert.equal(fs.existsSync(path.join(fx.archive, names[2])), true);
  const calls = fs.readFileSync(fx.rcloneLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(calls.filter((line) => line.startsWith('lsf ')).length, 1);
  assert.match(calls.find((line) => line.startsWith('lsf ')), /--files-only --max-depth 1/);
  assert.match(result.stdout, /pruned 2 uploaded local WAL files/);
});

test('WAL sync fails closed when the single R2 inventory cannot be read', (t) => {
  const fx = fixture(t);
  const name = '000000010000000000000004';
  makeOld(path.join(fx.archive, name));
  fs.writeFileSync(fx.remoteList, `${name}\n`);

  const result = runBash(path.join(root, 'ops/hetzner/backup/wal-sync.sh'), fx, { RCLONE_LSF_EXIT: '17' });
  if (!result) return t.skip('bash unavailable');

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(fx.archive, name)), true);
});

test('capacity watchdog reports a long-running oneshot instead of never-executed', (t) => {
  const fx = fixture(t);
  const started = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

  writeExecutable(path.join(fx.mockBin, 'docker'), `#!/usr/bin/env bash
sql="${'${*: -1}'}"
case "$sql" in
  *pg_current_wal_lsn*) echo '0/2000000' ;;
  *pg_database_size*) echo '1073741824' ;;
  *'count(distinct user_id)'*) echo '10' ;;
  *'sum(pg_total_relation_size'*) echo '104857600' ;;
  *'count(*)'*) echo '100000' ;;
  *) echo '0' ;;
esac
`);
  writeExecutable(path.join(fx.mockBin, 'df'), `#!/usr/bin/env bash
case "$*" in
  *'--output=avail'*) printf 'Avail\\n100000000000\\n' ;;
  *'--output=pcent'*) printf 'Use%%\\n10%%\\n' ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(fx.mockBin, 'systemctl'), `#!/usr/bin/env bash
prop="$4"
case "$prop" in
  ActiveState) echo activating ;;
  ExecMainStartTimestamp) echo "$CAPACITY_TEST_STARTED" ;;
  Result) echo success ;;
  ExecMainExitTimestamp) echo '' ;;
  *) exit 2 ;;
esac
`);

  const result = runBash(path.join(root, 'ops/hetzner/backup/capacity-check.sh'), fx, {
    CAPACITY_TEST_STARTED: started
  });
  if (!result) return t.skip('bash unavailable');

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /norva-wal-sync=en-cours-\d+min/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /norva-wal-sync=jamais-execute/);
});

test('WAL maintenance scripts share a lock and the oneshot has hard resource bounds', () => {
  assert.match(walSync, /acquire_wal_r2_lock/);
  assert.match(walPrune, /acquire_wal_r2_lock/);
  assert.match(walSync, /rclone lsf "\$DST" --files-only --max-depth 1/);
  assert.doesNotMatch(walSync, /rclone lsf "\$DST\/\$f"/);
  assert.match(capacityCheck, /ActiveState/);
  assert.match(capacityCheck, /en-cours-\$\{running_minutes\}min/);
  assert.match(timerInstaller, /TimeoutStartSec=30min/);
  assert.match(timerInstaller, /MemoryMax=1G/);
  assert.match(capacityCheck, /CAPACITY_TITLE_WARN_BYTES:-12000/);
  assert.doesNotMatch(capacityCheck, /cloud_title_variants, catalog_titles/);
  assert.match(
    reindexMonthly,
    /REINDEX_TABLES:-public\.cloud_titles public\.cloud_media_items public\.cloud_title_variants}/
  );
  assert.doesNotMatch(reindexMonthly, /REINDEX_TABLES:-[^\n]*catalog_titles/);
});

test('storage lifecycle jobs remain scoped and fail closed', () => {
  assert.match(proofGc, /MODE=dry-run/);
  assert.match(proofGc, /unexpected proof root/);
  assert.match(proofGc, /norva\.phase123\.production-clone/);
  assert.match(proofGc, /database mount identity mismatch/);
  assert.match(proofGc, /host ports are published/);
  assert.match(proofGc, /client sessions=\$sessions/);
  assert.match(proofGc, /rm -rf -- "\$resolved"/);
  assert.match(proofGc, /\[ "\$resolved" != \/proof-root \]/);

  assert.match(dockerGc, /MODE=dry-run/);
  assert.match(dockerGc, /used_ids\["\$image_id"\]=1/);
  assert.match(dockerGc, /norva\.retention/);
  assert.match(dockerGc, /norva-media-gateway:vaapi-\*/);
  assert.match(dockerGc, /norva-whisper-bench:\*/);
  assert.match(dockerGc, /--max-used-space "\$MAX_CACHE_SPACE"/);

  assert.match(storageWatch, /CAPACITY_PROOF_WARN_GIB:-25/);
  assert.match(storageWatch, /CAPACITY_BUILD_CACHE_WARN_GIB:-20/);
  assert.match(storageWatch, /CAPACITY_IMAGE_RECLAIMABLE_WARN_GIB:-15/);
  assert.match(timerInstaller, /User=adrien\nGroup=adrien\nEnvironmentFile=-\/etc\/norva-gc\.env/g);
});
