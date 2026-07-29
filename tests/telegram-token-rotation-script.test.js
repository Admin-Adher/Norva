const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(
  root,
  'ops',
  'hetzner',
  'scripts',
  'rotate-telegram-bot-token.sh',
);
const script = fs.readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('rotation helper has valid Bash syntax', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('secret input stays masked, TTY-bound and absent from argv-oriented helpers', () => {
  assert.match(script, /set \+x/);
  assert.match(script, /set \+v/);
  assert.match(script, /umask 077/);
  assert.match(script, /ulimit -c 0/);
  assert.match(script, /\[\[ -t 0 && -t 1 \]\]/);
  assert.match(script, /read -r -s -p "\$\{prompt_label\}[\s\S]*<\/dev\/tty/);
  assert.match(script, /read -r -s -p "Confirme le nouveau token[\s\S]*<\/dev\/tty/);
  assert.doesNotMatch(script, /curl[^\n]*\/bot\$\{?(?:token|NEW_TOKEN|OLD_TOKEN)/);
  assert.doesNotMatch(script, /(?:awk -v|sed -[ei])[^\n]*(?:TOKEN|token)/);
  assert.doesNotMatch(script, /(?:echo|say|printf)[^\n]*\$(?:NEW_TOKEN|OLD_TOKEN|CHAT_ID)/);
});

test('BotFather result must be the same bot, reach the same chat and revoke the old token', () => {
  const rotate = section(
    script,
    'else\n  say "Validation de l\'ancien bot',
    'say "Recréation progressive',
  );
  assert.ok(
    rotate.indexOf('telegram_get_me "$OLD_TOKEN"') <
      rotate.indexOf('read_new_token_twice'),
    'the old bot identity must be frozen before the user rotates it',
  );
  assert.match(rotate, /OLD_BOT_ID="\$PROBE_BOT_ID"/);
  assert.match(rotate, /telegram_get_chat "\$OLD_TOKEN" "\$CHAT_ID"/);
  assert.match(rotate, /telegram_get_me "\$NEW_TOKEN"/);
  assert.match(rotate, /\[\[ "\$PROBE_BOT_ID" == "\$OLD_BOT_ID" \]\]/);
  assert.match(rotate, /telegram_get_chat "\$NEW_TOKEN" "\$CHAT_ID"/);
  assert.match(rotate, /if telegram_get_me "\$OLD_TOKEN"; then/);
  assert.match(rotate, /PROBE_STATE" != "rejected"/);
  assert.match(rotate, /sudo -v[\s\S]*commit_token_files_safely "\$NEW_TOKEN"/);
});

test('the two protected files use prepared fsynced candidates and coordinated replacement', () => {
  const commit = section(
    script,
    'commit_token_files() {',
    '\n}\n\ncommit_token_files_safely',
  );
  assert.match(commit, /sudo -n python3 -c/);
  assert.match(commit, /os\.lstat\(path\)/);
  assert.match(commit, /stat\.S_ISLNK/);
  assert.match(commit, /matches != 1/);
  assert.match(commit, /tempfile\.mkstemp/);
  assert.match(commit, /os\.fsync\(handle\.fileno\(\)\)/);
  assert.match(commit, /signal\.pthread_sigmask\(signal\.SIG_BLOCK/);
  assert.match(commit, /os\.replace\(temps\[path\], path\)/);
  assert.match(commit, /for path in reversed\(replaced\)/);
  assert.match(commit, /os\.replace\(rollback, path\)/);
  assert.ok(
    commit.indexOf('signal.pthread_sigmask(signal.SIG_BLOCK') <
      commit.indexOf('temps[path] = make_temp'),
    'signals must be blocked before any token-bearing temp file is created',
  );
  assert.doesNotMatch(commit, /SIG_SETMASK/);
  assert.doesNotMatch(commit, /\b(?:sed|awk|install)\b/);
});

test('recovery mode can finish after BotFather revokes the old token before file commit', () => {
  assert.match(script, /--recover/);
  assert.match(script, /MODE="recover"/);
  assert.match(script, /write_recovery_state "\$OLD_BOT_ID" "\$PROBE_BOT_USERNAME"/);
  const recover = section(
    script,
    'elif [[ "$MODE" == "recover" ]]',
    '\nelse\n  say "Validation de l\'ancien bot',
  );
  assert.match(recover, /load_recovery_state/);
  assert.match(recover, /read_new_token_twice "Token Telegram déjà généré"/);
  assert.match(recover, /\[\[ "\$PROBE_BOT_ID" == "\$EXPECTED_BOT_ID" \]\]/);
  assert.match(recover, /telegram_get_chat "\$NEW_TOKEN" "\$CHAT_ID"/);
  assert.match(recover, /sudo -v[\s\S]*commit_token_files_safely "\$NEW_TOKEN"/);

  const recoveryState = section(
    script,
    'payload = {\n    "bot_id"',
    '\n}\n',
  );
  assert.doesNotMatch(recoveryState, /token|chat/i);
});

test('activation recreates every secret consumer and verifies loaded state', () => {
  assert.match(script, /for service in functions functions2/);
  assert.match(
    script,
    /up -d --no-deps --force-recreate "\$service"[\s\S]*wait_for_service "\$SUPABASE_COMPOSE" "\$service"/,
  );
  assert.match(
    script,
    /up -d --no-deps --force-recreate netdata[\s\S]*wait_for_service "\$MONITORING_COMPOSE" netdata/,
  );
  assert.match(script, /docker exec "\$container_id"[\s\S]*TELEGRAM_BOT_TOKEN/);
  assert.match(script, /loaded_chat_id[\s\S]*TELEGRAM_CHAT_ID/);
  assert.match(script, /docker exec "\$netdata_id"[\s\S]*health_alarm_notify\.conf/);
  assert.match(script, /netdata_chat_id[\s\S]*DEFAULT_RECIPIENT_TELEGRAM/);
  assert.match(script, /http:\/\/127\.0\.0\.1:19999\/api\/v1\/info/);
  assert.match(script, /worker_unauthorized_guard/);
});

test('resume mode and receipt expose operational proof but no credential material', () => {
  assert.match(script, /--resume/);
  assert.match(script, /MODE="resume"/);
  const receipt = section(script, 'cat > "$RECEIPT_TMP" <<EOF', '\nEOF');
  for (const field of [
    'bot_api_ok',
    'destination_reachable',
    'old_token_rejected',
    'files_committed',
    'edge_functions_recreated',
    'edge_tokens_match',
    'edge_destinations_match',
    'netdata_recreated',
    'netdata_token_matches',
    'netdata_destination_matches',
    'worker_unauthorized_guard',
  ]) {
    assert.match(receipt, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(
    receipt,
    /\$(?:NEW_TOKEN|OLD_TOKEN|CHAT_ID|BOT_USERNAME|PROBE_BOT_ID)/,
  );
  assert.doesNotMatch(
    receipt,
    /"(?:token|chat_id|bot_id|bot_username|hash|fingerprint)"\s*:/i,
  );
});
