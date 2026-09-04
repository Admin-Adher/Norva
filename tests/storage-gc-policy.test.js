'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const dockerGc = read('ops/hetzner/backup/docker-gc.sh');
const deploymentGc = read('ops/hetzner/backup/deployment-gc.sh');
const capacityCheck = read('ops/hetzner/backup/capacity-check.sh');
const timerInstaller = read('ops/hetzner/backup/install-timers.sh');

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

function makeOld(directory, hours) {
  fs.mkdirSync(directory, { recursive: true });
  const when = new Date(Date.now() - hours * 60 * 60_000);
  fs.utimesSync(directory, when, when);
}

test('Docker GC separates cache budget and free-space passes and verifies its post-condition', () => {
  assert.match(dockerGc, /--max-used-space "\$MAX_CACHE_SPACE"[\s\\]+\n\s*--reserved-space "\$RESERVED_CACHE_SPACE"/);
  assert.doesNotMatch(
    dockerGc,
    /--max-used-space "\$MAX_CACHE_SPACE"[\s\S]{0,160}--min-free-space "\$MIN_FREE_SPACE"/
  );
  assert.match(dockerGc, /DOCKER_GC_LIMIT_NOT_MET/);
  assert.match(dockerGc, /DOCKER_GC_MEDIA_IMAGE_MIN_AGE_HOURS:-48/);
  assert.match(dockerGc, /ROLLBACK_IMAGES_PER_FAMILY:-2/);
});

test('Deployment GC keeps active paths, protected markers and newest rollbacks', (t) => {
  const bash = bashBinary();
  if (!bash) return t.skip('bash unavailable');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-deployment-gc-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const allowedBase = path.join(fixture, 'home');
  const candidates = path.join(allowedBase, 'norva-candidates');
  const bin = path.join(fixture, 'bin');
  fs.mkdirSync(candidates, { recursive: true });
  fs.mkdirSync(bin);

  const active = path.join(candidates, 'active-old');
  const removable = path.join(candidates, 'removable-old');
  const protectedDir = path.join(candidates, 'protected-old');
  const newestA = path.join(candidates, 'newest-a');
  const newestB = path.join(candidates, 'newest-b');
  makeOld(active, 240);
  makeOld(removable, 220);
  makeOld(protectedDir, 200);
  fs.writeFileSync(path.join(protectedDir, '.norva-retain'), 'keep\n');
  makeOld(protectedDir, 200);
  makeOld(newestA, 2);
  makeOld(newestB, 1);

  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
case "$1" in
  ps) echo test-container ;;
  inspect) echo ${shellQuote(toBashPath(path.join(active, 'mounted-subdir')))} ;;
  *) exit 90 ;;
esac
`);
  writeExecutable(path.join(bin, 'findmnt'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(bin, 'git'), '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');

  const environment = [
    `export PATH=${shellQuote(toBashPath(bin))}:$PATH`,
    `export DEPLOYMENT_GC_ALLOWED_BASE=${shellQuote(toBashPath(allowedBase))}`,
    `export DEPLOYMENT_GC_ROOTS=${shellQuote(toBashPath(candidates))}`,
    `export DEPLOYMENT_GC_LOCK_FILE=${shellQuote(toBashPath(path.join(fixture, 'gc.lock')))}`,
    'export DEPLOYMENT_GC_CANDIDATE_TTL_HOURS=72',
    'export DEPLOYMENT_GC_KEEP_NEWEST_PER_ROOT=2'
  ].join('; ');

  const dryRun = spawnSync(
    bash,
    ['-c', `${environment}; ${shellQuote(toBashPath(path.join(root, 'ops/hetzner/backup/deployment-gc.sh')))} --dry-run`],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  assert.match(dryRun.stdout, /KEEP active-or-mounted .*active-old/);
  assert.match(dryRun.stdout, /KEEP protected-marker .*protected-old/);
  assert.match(dryRun.stdout, /DRY_RUN remove .*removable-old/);
  assert.equal(fs.existsSync(removable), true);

  const apply = spawnSync(
    bash,
    ['-c', `${environment}; ${shellQuote(toBashPath(path.join(root, 'ops/hetzner/backup/deployment-gc.sh')))} --apply`],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(protectedDir), true);
  assert.equal(fs.existsSync(newestA), true);
  assert.equal(fs.existsSync(newestB), true);
  assert.equal(fs.existsSync(removable), false);
});

test('Capacity watchdog tracks disk and remote WAL growth and monitors deployment GC', () => {
  assert.match(capacityCheck, /CAPACITY_DISK_GROWTH_WARN_GIB_DAY:-15/);
  assert.match(capacityCheck, /CAPACITY_R2_WAL_GROWTH_WARN_GIB_DAY:-15/);
  assert.match(capacityCheck, /rclone size .*R2_PREFIX_WAL.*--json --fast-list/);
  assert.match(capacityCheck, /PREV_USED_BYTES/);
  assert.match(capacityCheck, /PREV_R2_WAL_BYTES/);
  assert.match(capacityCheck, /PREV_R2_WAL_EPOCH/);
  assert.match(capacityCheck, /norva-deployment-gc/);
  assert.match(timerInstaller, /norva-deployment-gc\.service/);
  assert.match(timerInstaller, /deployment-gc\.sh --apply/);
});

test('Deployment GC is fail-safe by contract', () => {
  assert.match(deploymentGc, /DEPLOYMENT_GC_ALLOWED_BASE:-\/home\/adrien/);
  assert.match(deploymentGc, /KEEP active-or-mounted/);
  assert.match(deploymentGc, /KEEP dirty-worktree/);
  assert.match(deploymentGc, /\.norva-retain/);
  assert.match(deploymentGc, /KEEP protected-name/);
  assert.match(deploymentGc, /git -C "\$candidate" worktree remove/);
  assert.match(deploymentGc, /DEPLOYMENT_GC_OK mode=\$MODE/);
});
