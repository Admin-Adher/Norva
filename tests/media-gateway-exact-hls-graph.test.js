'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const fsp = fs.promises;
const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'media-gateway', 'src', 'index.js'),
  'utf8',
).replace(/\r\n?/g, '\n');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadCollector() {
  const block = between(
    'function flatCompleteHlsReferences(',
    '\nfunction completeHlsGraphForSession(',
  );
  const context = {
    fsp,
    path,
    MKV_COMPLETE_HLS_CACHE_MAX_FILES: 10_000,
    MKV_COMPLETE_HLS_CACHE_MAX_PLAYLIST_BYTES: 2 * 1024 * 1024,
    isWithin(root, candidate) {
      const relative = path.relative(path.resolve(root), path.resolve(candidate));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    },
    safeSessionArtifactName(value) {
      const raw = String(value || '');
      return raw && raw === path.basename(raw) && /^[a-z0-9][a-z0-9._-]*$/i.test(raw)
        ? raw
        : null;
    },
  };
  vm.runInNewContext(`${block}; this.collect = collectCompleteHlsSessionAssets;`, context);
  return context.collect;
}

async function write(root, name, value) {
  await fsp.writeFile(path.join(root, name), value);
}

test('complete graph collection follows every audio and WebVTT rendition before manifest-last publication', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-exact-hls-graph-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await write(root, 'playlist.m3u8', [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio_0.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="norva_subtitles",NAME="English",URI="subtitle_0.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio",SUBTITLES="norva_subtitles"',
    'video.m3u8',
    '',
  ].join('\n'));
  await write(root, 'video.m3u8', '#EXTM3U\n#EXTINF:2,\nvideo-00000.ts\n#EXT-X-ENDLIST\n');
  await write(root, 'audio_0.m3u8', '#EXTM3U\n#EXTINF:2,\naudio-00000.ts\n#EXT-X-ENDLIST\n');
  await write(root, 'subtitle_0.m3u8', '#EXTM3U\n#EXTINF:2,\nsubtitle_0-00000.vtt\n#EXT-X-ENDLIST\n');
  await write(root, 'video-00000.ts', Buffer.alloc(188, 0x47));
  await write(root, 'audio-00000.ts', Buffer.alloc(188, 0x47));
  await write(root, 'subtitle_0-00000.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');

  const collect = loadCollector();
  const graph = await collect({ outputDir: root, playlistPath: path.join(root, 'playlist.m3u8') });
  assert.deepEqual(Array.from(graph.files), [
    'audio-00000.ts',
    'audio_0.m3u8',
    'playlist.m3u8',
    'subtitle_0-00000.vtt',
    'subtitle_0.m3u8',
    'video-00000.ts',
    'video.m3u8',
  ]);

  await fsp.rm(path.join(root, 'subtitle_0-00000.vtt'));
  await assert.rejects(
    collect({ outputDir: root, playlistPath: path.join(root, 'playlist.m3u8') }),
    /ENOENT|CACHE_ASSET_INVALID/,
  );
});

test('Gateway finalizes the exact graph before any local or shared cache becomes ready', () => {
  const closeHandler = between("child.on('close', () => {", '\n\n    if (pumpedMkvInput)');
  const finalize = closeHandler.indexOf('finalizeSessionExactHlsTrackGraph(session)');
  const ready = closeHandler.indexOf('session.completeHlsCacheMediaReady = true');
  const localPublish = closeHandler.indexOf('scheduleMkvCompleteHlsCachePromotion(session)');
  const sharedPublish = closeHandler.indexOf('scheduleSharedMediaCachePublication(session)');
  assert.ok(finalize >= 0 && finalize < ready);
  assert.ok(ready < localPublish && localPublish < sharedPublish);
  assert.match(closeHandler, /finalizeSessionExactHlsTrackGraph\(session\)\.then\(\(\) => \{/);
  assert.match(closeHandler, /\.catch\(\(error\) => \{[\s\S]*background-failed/);

  const ffmpeg = between('function startFfmpeg(', '\nfunction seekArgsForSession(');
  const output = ffmpeg.indexOf('args.push(...hlsOutputArgs)');
  const subtitles = ffmpeg.indexOf('appendSubtitleOutputs(args, session, postInputSeek)');
  const spawn = ffmpeg.indexOf('spawn(FFMPEG_PATH, args');
  assert.ok(output >= 0 && output < subtitles && subtitles < spawn,
    'video, every audio track and every subtitle track stay in one FFmpeg process');
});
