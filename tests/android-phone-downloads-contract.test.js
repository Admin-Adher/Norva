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
).replace(/\r\n/g, '\n');
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

test('prototype D separates active, queue, ready and attention journeys', () => {
  const render = method('private void renderStructure(Snapshot snapshot)');
  const header = method('private void renderHeader(Snapshot snapshot)');

  assert.match(render, /R\.string\.downloads_active_transfer/);
  assert.match(render, /featuredTransferCard\(featured\)/);
  assert.match(render, /R\.string\.downloads_ordered_queue/);
  assert.match(render, /queueCard\(queue\.get\(index\), index \+ 2\)/);
  assert.match(render, /R\.string\.downloads_ready_offline/);
  assert.match(render, /readyShelf\(readyMovies, readyShows\)/);
  assert.match(render, /seriesDetailCard\(selectedSeriesTitle, selected\)/);
  assert.match(render, /R\.string\.downloads_needs_attention/);
  assert.match(render, /attentionCard\(item\)/);
  assert.match(header, /readyCount\.setText/);
  assert.match(header, /movingCount\.setText/);
  assert.match(header, /attentionCount\.setText/);
  assert.match(header, /storageRail\.setProgress/);
  assert.match(header, /R\.string\.downloads_paused_overview/);
  assert.match(header, /R\.plurals\.downloads_paused_with_pending/);
  assert.match(header, /queuedCount > 0/);
});

test('ready VOD deletion is long-press first with a subtle accessible fallback', () => {
  const movie = method('private View readyMovieTile(final DownloadStore.Item item)');
  const series = method('private View readyShowTile(');
  const itemGesture = method('private void configureDeleteGesture(\n            final View target,\n            final DownloadStore.Item item)');
  const seriesDelete = method('private void confirmDeleteSeries(');

  assert.match(movie, /setOnClickListener\(v -> playLocal\(item\)\)/);
  assert.match(movie, /configureDeleteGesture\(tile, item\)/);
  assert.match(movie, /if \(manageReady\) tile\.addView\(manageDeleteButton\(item\)\)/);
  assert.match(series, /selectedSeriesTitle = showTitle/);
  assert.match(series, /configureDeleteGesture\(tile, showTitle, episodes\)/);
  assert.match(itemGesture, /setOnLongClickListener/);
  assert.match(itemGesture, /HapticFeedbackConstants\.LONG_PRESS/);
  assert.match(itemGesture, /confirmDelete\(item\)/);
  assert.match(seriesDelete, /styledConfirm/);
  assert.match(seriesDelete, /DownloadService\.requestCancel/);
  assert.match(source, /ACTION_LONG_CLICK/);
  assert.match(source, /R\.string\.downloads_manage_show_description/);
  assert.match(source, /R\.string\.downloads_manage_hide_description/);
});

test('prototype D keeps rules collapsed until requested and models progress semantically', () => {
  const create = method('protected void onCreate(Bundle b)');
  const rules = method('private void setRulesExpanded(boolean expanded, boolean announce)');
  const railAt = source.indexOf('static final class ProgressRail extends View');
  const rail = source.slice(railAt, source.indexOf('\n    }', railAt) + 6);

  assert.match(create, /setRulesExpanded\(false, false\)/);
  assert.match(create, /rulesHeader\.setDescendantFocusability\(ViewGroup\.FOCUS_BLOCK_DESCENDANTS\)/);
  assert.match(create, /rulesChevron\.setClickable\(false\)/);
  assert.match(rules, /rulesBody\.setVisibility\(expanded \? View\.VISIBLE : View\.GONE\)/);
  assert.match(rules, /R\.string\.downloads_rules_expanded/);
  assert.match(rules, /R\.string\.downloads_rules_collapsed/);
  assert.match(rail, /info\.setClassName\("android\.widget\.ProgressBar"\)/);
  assert.match(rail, /RangeInfo\.obtain/);
  assert.match(source, /android\.R\.attr\.state_pressed/);
  assert.match(source, /pressableRoundedStroke\(CARD, SUBTLE, CARD_BORDER, 14\)/);
  assert.match(source, /pressableRounded\(bg, pressedColor\(bg\), 10\)/);
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

test('downloads user-facing and accessibility copy covers every supported interface locale', () => {
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
  }

  const locales = require('../i18n/locales.json');
  for (const locale of locales.filter(l => l.code !== 'en')) {
    const xml = fs.readFileSync(path.join(root, 'clients/android-phone/app/src/main/res', locale.android, 'strings.xml'), 'utf8');
    for (const name of resourceNames) {
      if (/_glyph$/.test(name) || name === 'downloads_metric_pending') continue;
      assert.match(xml, new RegExp('<(?:string|plurals)\\s+name="' + name + '"'), locale.code + ':' + name);
    }
  }
  assert.doesNotMatch(source, /setText\(\s*"[^"]*[A-Za-z][^"]*"\s*\)/);
  assert.doesNotMatch(
    source,
    /(?:setContentDescription|announceForAccessibility|setStateDescription)\(\s*"[^"]*[A-Za-z][^"]*"/,
  );
  assert.match(source, /NumberFormat\.getNumberInstance\(Locale\.forLanguageTag\(tv\.norva\.i18n\.UiLanguage\.resolved\(this\)\)\)/);
  assert.match(source, /NumberFormat\.getIntegerInstance\(Locale\.forLanguageTag\(tv\.norva\.i18n\.UiLanguage\.resolved\(this\)\)\)/);
  assert.match(
    englishStrings,
    /<plurals name="downloads_episode_count"(?:\s[^>]*)?>/,
  );
});

test('downloads reserves Android navigation bars and display cutouts', () => {
  assert.match(source, /setDecorFitsSystemWindows\(false\)/);
  assert.match(
    source,
    /WindowInsets\.Type\.systemBars\(\)[\s\S]*WindowInsets\.Type\.displayCutout\(\)/,
  );
  assert.match(source, /scroll\.setClipToPadding\(true\)/);
  assert.match(
    source,
    /scroll\.setPadding\(safe\.left, safe\.top, safe\.right, safe\.bottom\)/,
  );
  assert.match(source, /final int pageGutterDp = pageGutterDp\(\)/);
  assert.match(source, /if \(widthDp >= 840\) return 96/);
  assert.match(source, /if \(widthDp >= 600\) return 64/);
});
