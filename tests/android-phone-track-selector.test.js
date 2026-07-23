const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadTrackMetadataHelpers(mediaUtils = null) {
  const source = read('public/js/utils/standalone.js');
  const helpers = section(
    source,
    'const NATIVE_ACCEPTED_AUDIO_EVIDENCE',
    'const nativePlay =',
  );
  return vm.runInNewContext(
    `(() => { ${helpers}; return {
      safeNativeTrackLanguage,
      normalizeNativeTrack,
      buildNativeTrackMetadata,
    }; })()`,
    { window: { MediaUtils: mediaUtils } },
  );
}

test('native metadata is exact-file only and strips provider/category labels', () => {
  const { buildNativeTrackMetadata } = loadTrackMetadataHelpers();
  const unsafe = ['Netflix', 'Nordic', 'Audio 2', 'Unknown', '', 'language'];

  for (const language of unsafe) {
    const metadata = buildNativeTrackMetadata({
      audioLanguageValidationStatus: 'verified',
      audioTracksScope: 'file',
      audioTracks: [{ index: 1, language }],
    });
    assert.ok(metadata, `track ${JSON.stringify(language)} should remain addressable`);
    assert.equal(metadata.audioTracks[0].lang, undefined);
  }

  assert.equal(buildNativeTrackMetadata({
    audioLanguageValidationStatus: 'verified',
    audioTracksScope: 'title',
    audioTracks: [{ index: 1, lang: 'fr' }],
  }), null);

  assert.equal(buildNativeTrackMetadata({
    audioLanguageValidationStatus: 'pending',
    audioTracksScope: 'file',
    audioTracks: [{ index: 1, lang: 'fr' }],
  }), null);
});

test('native metadata preserves safe exact-file language, role and format facts', () => {
  const { buildNativeTrackMetadata } = loadTrackMetadataHelpers();
  const metadata = buildNativeTrackMetadata({
    audioLanguageValidationStatus: 'verified',
    audioTracksScope: 'file',
    audioTracks: [
      { index: 1, lang: 'fra', codec: 'eac3', channels: 6 },
      { index: 2, lang: 'eng', codec: 'aac', channels: 2 },
    ],
    subtitleTracksScope: 'file',
    subtitleTracks: [
      { index: 3, lang: 'fr', codec: 'subrip', forced: true },
      { index: 4, lang: 'en', codec: 'webvtt', sdh: true },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), {
    audioValidationStatus: 'verified',
    audioTracksScope: 'file',
    audioTracks: [
      { index: 1, lang: 'fra', codec: 'eac3', channels: 6 },
      { index: 2, lang: 'eng', codec: 'aac', channels: 2 },
    ],
    subtitleTracksScope: 'file',
    subtitleTracks: [
      { index: 3, lang: 'fr', codec: 'subrip', forced: true },
      { index: 4, lang: 'en', codec: 'webvtt', sdh: true },
    ],
  });
});

test('native metadata identifies a conservative burned-in subtitle as always on', () => {
  const { buildNativeTrackMetadata } = loadTrackMetadataHelpers({
    deriveTrackIntel({ title, hasSubtitleStream }) {
      assert.equal(title, 'AR-SUBS - Example');
      assert.equal(hasSubtitleStream, false);
      return { subtitle: { type: 'burned-in', code: 'ara' } };
    },
  });
  const metadata = buildNativeTrackMetadata({
    title: 'AR-SUBS - Example',
    subtitleTracksScope: 'file',
    subtitleTracks: [],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(metadata.burnedSubtitle)), { lang: 'ara' });
  assert.equal(metadata.subtitleTracks.length, 0);

  const player = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  assert.match(player, /hasBurnedSubtitle/);
  assert.match(player, /player_subtitles_burned_in_detail/);
  assert.match(player, /burnedSubtitleLabel\(\)/);
});

test('Android phone exposes one unified selector and keeps failed changes in-place', () => {
  const player = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  const selector = section(
    player,
    '// ==================== Unified audio & subtitles ====================',
    '// ==================== Error display ====================',
  );

  assert.match(player, /setShowSubtitleButton\(false\)/);
  assert.match(player, /installTrackControl\(root\)/);
  assert.match(selector, /player_tracks_title/);
  assert.match(selector, /player_audio_section/);
  assert.match(selector, /player_subtitle_section/);
  assert.match(selector, /player_subtitles_off/);
  assert.match(selector, /setMinHeight\(dp\(48\)\)/);
  assert.match(selector, /setOverrideForType\(new TrackSelectionOverride/);
  assert.match(selector, /setTrackTypeDisabled\(C\.TRACK_TYPE_TEXT,\s*true\)/);

  const selection = section(
    selector,
    'private boolean selectTrack(TrackOption option)',
    'private boolean disableSubtitles()',
  );
  assert.doesNotMatch(selection, /finish\(\)|startActivity|requestFreshStream/);
  assert.match(selection, /player_track_change_failed/);
});

test('track metadata crosses the JSON bridge without exporting the player activity', () => {
  const standalone = read('public/js/utils/standalone.js');
  const main = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
  const player = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  const manifest = read('clients/android-phone/app/src/main/AndroidManifest.xml');

  assert.match(standalone, /trackMetadata:\s*extras\?\.trackMetadata \|\| null/);
  assert.match(standalone, /trackMetadata:\s*buildNativeTrackMetadata\(content\)/);
  assert.match(main, /optJSONObject\("trackMetadata"\)/);
  assert.match(main, /EXTRA_TRACK_METADATA/);
  assert.match(player, /readTrackMetadata\(getIntent\(\)\.getStringExtra\(EXTRA_TRACK_METADATA\)\)/);
  assert.match(
    manifest,
    /android:name="\.PlayerActivity"[\s\S]*?android:exported="false"/,
  );
});
