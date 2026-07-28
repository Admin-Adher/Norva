'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(
    root,
    'clients/android-phone/app/src/main/java/tv/norva/phone/DownloadsActivity.java',
  ),
  'utf8',
);
const englishStrings = fs.readFileSync(
  path.join(root, 'clients/android-phone/app/src/main/res/values/strings.xml'),
  'utf8',
);
const frenchStrings = fs.readFileSync(
  path.join(root, 'clients/android-phone/app/src/main/res/values-fr/strings.xml'),
  'utf8',
);

function method(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method: ${signature}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `missing method body: ${signature}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated method: ${signature}`);
}

test('downloads polling is coalesced and keeps manifest/storage/poster work off main', () => {
  const request = method('private void requestRefresh(boolean force)');
  const load = method('private Snapshot loadSnapshot(');
  const pollAt = source.indexOf('private final Runnable poll');
  const poll = source.slice(pollAt, source.indexOf('};', pollAt) + 2);

  assert.match(poll, /requestRefresh\(false\)/);
  assert.doesNotMatch(poll, /DownloadStore\.all|BitmapFactory|usedBytes|freeBytes/);
  assert.match(request, /if \(refreshInFlight\)/);
  assert.match(request, /refreshQueued = true/);
  assert.match(request, /forceQueuedRefresh \|= force/);
  assert.match(request, /refreshExecutor\.submit/);
  assert.match(load, /DownloadStore\.all\(getApplicationContext\(\)\)/);
  assert.match(load, /usedBytes\(\)/);
  assert.match(load, /freeBytes\(\)/);
  assert.match(load, /decodePoster\(path, targetPx\)/);
  assert.match(source, /new LruCache<String, Bitmap>/);
});

test('downloads snapshots reject stale lifecycle, mutation and sequence commits', () => {
  const commit = method('private void commitSnapshot(Snapshot snapshot)');
  const pause = method('protected void onPause()');
  const destroy = method('protected void onDestroy()');

  assert.match(commit, /snapshot\.lifecycleGeneration != lifecycleGeneration/);
  assert.match(commit, /snapshot\.mutationGeneration != mutationGeneration/);
  assert.match(commit, /snapshot\.sequence <= committedRefreshSequence/);
  assert.match(commit, /if \(structureChanged\) renderStructure\(snapshot\)/);
  assert.match(commit, /updateStatusViews\(snapshot\.items\)/);
  assert.match(pause, /refreshTaskToken\+\+/);
  assert.match(pause, /refreshFuture\.cancel\(true\)/);
  assert.match(destroy, /refreshExecutor\.shutdownNow\(\)/);
  assert.match(destroy, /posterCache\.evictAll\(\)/);
});

test('downloads posters are snapshot-bound and never decoded while building views', () => {
  const posterView = method(
    'private ImageView posterView(DownloadStore.Item it, int wDp, int hDp)',
  );
  const decoder = method('private static Bitmap decodePoster(String path, int targetPx)');

  assert.match(posterView, /currentSnapshot\.posters\.get\(it\.id\)/);
  assert.doesNotMatch(posterView, /BitmapFactory|decodeFile|posterPathFor/);
  assert.match(decoder, /inJustDecodeBounds = true/);
  assert.match(decoder, /inSampleSize = sample/);
  assert.match(decoder, /Bitmap\.Config\.RGB_565/);
});

test('download writes run in background and clear-all uses the committed snapshot', () => {
  const mutation = method('private void executeMutation(int successMessageRes, Runnable work)');
  const clearAll = method('private void confirmClearAll()');
  const deleteOne = method('private void confirmDelete(final DownloadStore.Item it)');

  assert.match(mutation, /mutationExecutor\.execute/);
  assert.match(mutation, /\+\+mutationGeneration/);
  assert.match(mutation, /lifecycle == lifecycleGeneration/);
  assert.match(mutation, /requestRefresh\(true\)/);
  assert.match(clearAll, /Snapshot snapshot = currentSnapshot/);
  assert.doesNotMatch(clearAll, /DownloadStore\.all/);
  assert.match(clearAll, /executeMutation/);
  assert.match(deleteOne, /executeMutation/);
});

test('downloads exposes one semantic switch owner and explicit accessible actions', () => {
  const toggleRow = method('private void configureToggleRow(');
  const actions = method('private void addActions(');
  const season = method('private LinearLayout seasonHeader(');

  assert.match(toggleRow, /row\.setMinimumHeight\(dp\(64\)\)/);
  assert.match(toggleRow, /toggle\.setImportantForAccessibility\(View\.IMPORTANT_FOR_ACCESSIBILITY_NO\)/);
  assert.match(toggleRow, /info\.setClassName\("android\.widget\.Switch"\)/);
  assert.match(toggleRow, /info\.setCheckable\(true\)/);
  assert.match(toggleRow, /AccessibilityAction/);
  assert.doesNotMatch(source, /wifi\.setOnClickListener|smart\.setOnClickListener/);
  assert.match(actions, /R\.string\.downloads_action_move_earlier/);
  assert.match(actions, /R\.string\.downloads_action_move_later/);
  assert.match(season, /setMinimumHeight\(dp\(48\)\)/);
  assert.match(season, /syncSeasonHeaderAccessibility/);
  assert.match(source, /b\.setMinimumWidth\(dp\(48\)\)/);
  assert.match(source, /b\.setMinimumHeight\(dp\(48\)\)/);
});

test('downloads disables destructive empty action, sanitizes errors and announces states', () => {
  const clearState = method('private void setClearAllEnabled(boolean enabled)');
  const bindStatus = method('private void bindStatus(TextView s, DownloadStore.Item it)');
  const announcements = method(
    'private void announceSnapshotChanges(Snapshot previous, Snapshot next)',
  );

  assert.match(clearState, /setEnabled\(enabled\)/);
  assert.match(clearState, /setClickable\(enabled\)/);
  assert.match(clearState, /R\.string\.downloads_clear_all_disabled_description/);
  assert.doesNotMatch(bindStatus, /it\.error/);
  assert.match(bindStatus, /R\.string\.downloads_status_failed/);
  assert.match(announcements, /pct \/ 10/);
  assert.match(announcements, /R\.string\.downloads_a11y_ready_offline/);
  assert.match(announcements, /R\.string\.downloads_a11y_failed/);
});

test('downloads user-facing and accessibility copy is resource-backed in English and French', () => {
  const resourceNames = new Set(
    [...source.matchAll(/R\.(?:string|plurals)\.(downloads_[a-z0-9_]+)/g)]
      .map((match) => match[1]),
  );

  assert.ok(resourceNames.size > 50, 'expected the complete Downloads copy contract');
  for (const resourceName of resourceNames) {
    const declaration = new RegExp(
      `<(?:string|plurals)\\s+name="${resourceName}"(?:\\s|>)`,
    );
    assert.match(englishStrings, declaration, `missing English ${resourceName}`);
    assert.match(frenchStrings, declaration, `missing French ${resourceName}`);
  }

  assert.doesNotMatch(source, /setText\(\s*"[^"]*[A-Za-z][^"]*"\s*\)/);
  assert.doesNotMatch(
    source,
    /(?:setContentDescription|announceForAccessibility|setStateDescription)\(\s*"[^"]*[A-Za-z][^"]*"/,
  );
  assert.match(englishStrings, /<plurals name="downloads_episode_count">/);
  assert.match(frenchStrings, /<item quantity="many">/);
});

test('downloads reserves Android navigation bars and display cutouts', () => {
  assert.match(source, /setDecorFitsSystemWindows\(false\)/);
  assert.match(
    source,
    /WindowInsets\.Type\.systemBars\(\)[\s\S]*WindowInsets\.Type\.displayCutout\(\)/,
  );
  assert.match(source, /dp\(24\) \+ safe\.bottom/);
});
