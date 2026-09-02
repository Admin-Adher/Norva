'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildExactSubtitleHlsPlan,
  exactAudioName,
  exactSubtitleOutputArgs,
  finalizeExactHlsTrackGraph,
  rewriteExactHlsMaster,
} = require('../services/media-gateway/src/sharedHlsTracks');

const plain = (value) => JSON.parse(JSON.stringify(value));

test('unknown audio renditions receive stable non-duplicated labels', () => {
  const plan = {
    enabled: true,
    audioRenditions: [
      { hlsIndex: 0, language: 'und' },
      { hlsIndex: 1, language: 'und' },
      { hlsIndex: 2, language: 'eng' },
    ],
  };
  assert.deepEqual(plan.audioRenditions.map((rendition) => exactAudioName(plan, rendition)), [
    'Audio 1',
    'Audio 2',
    'ENG',
  ]);
});

function profile(subtitles) {
  return { metadataComplete: true, subtitles };
}

function exactTextTrack(index, language, title, overrides = {}) {
  return {
    index,
    language,
    title,
    codec: 'subrip',
    subtitleType: 'text',
    extractable: true,
    default: false,
    forced: false,
    ...overrides,
  };
}

function multiAudioPlan() {
  return {
    enabled: true,
    audioRenditions: [
      { hlsIndex: 0, streamIndex: 1, language: 'eng', title: 'English 5.1' },
      { hlsIndex: 1, streamIndex: 2, language: 'fra', title: 'Français 5.1' },
    ],
  };
}

function ffmpegMaster() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_0",DEFAULT=YES,LANGUAGE="eng",URI="audio_0.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_1",DEFAULT=NO,LANGUAGE="fra",URI="audio_1.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001f",AUDIO="group_audio"',
    'video.m3u8',
    '',
  ].join('\n');
}

test('exact subtitle plan preserves every bounded text track and builds a prioritized partial playback cohort', () => {
  const tracks = [
    exactTextTrack(3, 'eng', 'English', { default: true }),
    exactTextTrack(7, 'fra', 'Français', { forced: true }),
    exactTextTrack(9, 'eng', 'English', { hearingImpaired: true }),
  ];
  const plan = buildExactSubtitleHlsPlan(profile(tracks), { maxRenditions: 8 });
  assert.equal(plan.enabled, true);
  assert.equal(plan.cacheEligible, true);
  assert.deepEqual(plain(plan.renditions.map((track) => ({
    hlsIndex: track.hlsIndex,
    streamIndex: track.streamIndex,
    language: track.language,
    title: track.title,
    default: track.default,
    forced: track.forced,
    hearingImpaired: track.hearingImpaired,
  }))), [
    { hlsIndex: 0, streamIndex: 3, language: 'eng', title: 'English', default: true, forced: false, hearingImpaired: false },
    { hlsIndex: 1, streamIndex: 7, language: 'fra', title: 'Français', default: false, forced: true, hearingImpaired: false },
    { hlsIndex: 2, streamIndex: 9, language: 'eng', title: 'English 2', default: false, forced: false, hearingImpaired: true },
  ]);

  const image = buildExactSubtitleHlsPlan(profile([
    exactTextTrack(3, 'eng', 'English'),
    { index: 4, codec: 'hdmv_pgs_subtitle', subtitleType: 'image', extractable: false },
  ]));
  assert.equal(image.enabled, false);
  assert.equal(image.cacheEligible, false);
  assert.equal(image.reason, 'unsupported-or-inexact-subtitle');

  const tooManyTracks = [
    exactTextTrack(3, 'ara', 'Arabic', { default: true }),
    exactTextTrack(4, 'hrv', 'Croatian', { forced: true }),
    exactTextTrack(5, 'ces', 'Czech'),
    exactTextTrack(6, 'dan', 'Danish'),
    exactTextTrack(7, 'nld', 'Dutch'),
    exactTextTrack(8, 'eng', 'English'),
    exactTextTrack(9, 'fra', 'French'),
    exactTextTrack(10, 'deu', 'German'),
    exactTextTrack(11, 'spa', 'Spanish'),
  ];
  const tooMany = buildExactSubtitleHlsPlan(profile(tooManyTracks), {
    maxRenditions: 8,
    requestedStreamIndex: 9,
  });
  assert.equal(tooMany.enabled, true);
  assert.equal(tooMany.cacheEligible, false, 'a partial graph must never become a complete shared-cache object');
  assert.equal(tooMany.reason, 'enabled-partial');
  assert.equal(tooMany.sourceTrackCount, 9);
  assert.deepEqual(plain(tooMany.renditions.map((track) => track.streamIndex)), [9, 3, 4, 5, 6, 7, 8, 10]);
  assert.equal(tooMany.renditions.some((track) => track.streamIndex === 11), false);
});

test('one FFmpeg process maps every exact subtitle to a segmented WebVTT output', () => {
  const plan = buildExactSubtitleHlsPlan(profile([
    exactTextTrack(3, 'eng', 'English'),
    exactTextTrack(4, 'fra', 'Français'),
  ]));
  const args = exactSubtitleOutputArgs(plan, path.join('C:', 'sessions', 'one'), ['-ss', '1.25']);
  const maps = args.flatMap((value, index) => value === '-map' ? [args[index + 1]] : []);
  assert.deepEqual(maps, ['0:3', '0:4']);
  assert.equal(args.filter((value) => value === '-f').length, 2);
  assert.equal(args.filter((value) => value === 'segment').length, 2);
  assert.equal(args.filter((value) => value === 'webvtt').length, 4);
  assert.equal(args.filter((value) => value === '-ss').length, 2);
  assert.match(args.join(' '), /subtitle_0-%05d\.vtt/);
  assert.match(args.join(' '), /subtitle_1-%05d\.vtt/);
});

test('master finalization keeps useful audio labels and exposes exact subtitle attributes', () => {
  const subtitlePlan = buildExactSubtitleHlsPlan(profile([
    exactTextTrack(3, 'eng', 'English', { default: true }),
    exactTextTrack(4, 'fra', 'Français - SDH', { hearingImpaired: true }),
  ]));
  const rewritten = rewriteExactHlsMaster(ffmpegMaster(), {
    audioPlan: multiAudioPlan(),
    subtitlePlan,
  });
  assert.match(rewritten, /TYPE=AUDIO[^\n]+NAME="ENG"[^\n]+X-NORVA-STREAM-INDEX="1"/);
  assert.match(rewritten, /TYPE=AUDIO[^\n]+NAME="FRA"[^\n]+X-NORVA-STREAM-INDEX="2"/);
  assert.match(rewritten, /TYPE=SUBTITLES[^\n]+NAME="English"[^\n]+DEFAULT=YES[^\n]+URI="subtitle_0\.m3u8"[^\n]+X-NORVA-STREAM-INDEX="3"/);
  assert.match(rewritten, /TYPE=SUBTITLES[^\n]+NAME="Français - SDH"[^\n]+CHARACTERISTICS="public\.accessibility\.transcribes-spoken-dialog"/);
  assert.match(rewritten, /#EXT-X-STREAM-INF:[^\n]+SUBTITLES="norva_subtitles"/);
  assert.equal((rewritten.match(/GROUP-ID="norva_subtitles"/g) || []).length, 2);

  const idempotent = rewriteExactHlsMaster(rewritten, {
    audioPlan: multiAudioPlan(),
    subtitlePlan,
  });
  assert.equal(idempotent, rewritten);
});

test('manifest-last finalization rejects incomplete WebVTT and atomically publishes the exact graph', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'norva-exact-hls-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const masterPath = path.join(root, 'playlist.m3u8');
  await fs.promises.writeFile(masterPath, ffmpegMaster());
  const subtitlePlan = buildExactSubtitleHlsPlan(profile([
    exactTextTrack(3, 'eng', 'English'),
    exactTextTrack(4, 'fra', 'Français'),
  ]));
  await fs.promises.writeFile(path.join(root, 'subtitle_0-00000.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n');
  await fs.promises.writeFile(path.join(root, 'subtitle_0.m3u8'), [
    '#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.000,',
    'subtitle_0-00000.vtt', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  await assert.rejects(() => finalizeExactHlsTrackGraph({
    outputDirectory: root,
    masterPath,
    masterRequired: true,
    audioPlan: multiAudioPlan(),
    subtitlePlan,
  }), (error) => error?.code === 'SUBTITLE_PLAYLIST_MISSING');
  assert.equal((await fs.promises.readFile(masterPath, 'utf8')), ffmpegMaster(), 'master remains invisible until every rendition is complete');

  await fs.promises.writeFile(path.join(root, 'subtitle_1-00000.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nBonjour\n');
  await fs.promises.writeFile(path.join(root, 'subtitle_1.m3u8'), [
    '#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.000,',
    'subtitle_1-00000.vtt', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  const result = await finalizeExactHlsTrackGraph({
    outputDirectory: root,
    masterPath,
    masterRequired: true,
    audioPlan: multiAudioPlan(),
    subtitlePlan,
  });
  assert.equal(result.subtitleRenditions, 2);
  const published = await fs.promises.readFile(masterPath, 'utf8');
  assert.match(published, /subtitle_0\.m3u8/);
  assert.match(published, /subtitle_1\.m3u8/);
  assert.deepEqual((await fs.promises.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});
