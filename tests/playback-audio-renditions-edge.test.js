'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'supabase/functions/norva-playback/index.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadNormalizer() {
  let block = between(
    'function normalizeGatewayAudioRenditions(',
    '\nfunction normalizeGatewaySubtitleLanguage(',
  );
  block = block
    .replace(
      'function normalizeGatewayAudioRenditions(value: unknown, selectedStreamIndex: number | null)',
      'function normalizeGatewayAudioRenditions(value, selectedStreamIndex)',
    )
    .replace('const normalized: JsonRecord[] = [];', 'const normalized = [];')
    .replace('new Set<number>()', 'new Set()')
    .replace(
      /function normalizeGatewayMultiAudioHls\(\n  value: unknown,\n  renditions: JsonRecord\[\] \| null,\n  selectedStreamIndex: number \| null,\n  codecProfileValue: unknown = null,\n\)/,
      'function normalizeGatewayMultiAudioHls(\n  value,\n  renditions,\n  selectedStreamIndex,\n  codecProfileValue = null,\n)',
    );
  const context = {
    Number,
    Set,
    recordOrEmpty: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  };
  vm.runInNewContext(
    `${block}; this.normalize = normalizeGatewayAudioRenditions; this.normalizeMetadata = normalizeGatewayMultiAudioHls;`,
    context,
  );
  return context;
}

const valid = [
  {
    hlsIndex: 0,
    streamIndex: 2,
    language: 'eng',
    title: 'English',
    sourceChannels: 6,
    outputChannels: 2,
    codec: 'aac',
  },
  {
    hlsIndex: 1,
    streamIndex: 5,
    language: 'fra',
    title: 'Français',
    sourceChannels: 2,
    outputChannels: 2,
    codec: 'aac',
  },
];

const validMetadata = {
  protocol: 1,
  enabled: true,
  reason: 'enabled',
  maxAudioRenditions: 12,
  sourceTrackCount: 2,
  preparedTrackCount: 2,
  masterPlaylist: 'playlist.m3u8',
  videoPlaylist: 'video.m3u8',
  defaultHlsIndex: 1,
  defaultStreamIndex: 5,
};

test('valid Gateway renditions round-trip exactly from absolute streams to playback metadata', () => {
  const { normalize, normalizeMetadata } = loadNormalizer();
  const normalized = JSON.parse(JSON.stringify(normalize(valid, 5)));
  assert.deepEqual(normalized, valid);
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeMetadata(validMetadata, normalized, 5))),
    validMetadata,
  );

  const gateway = between(
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  assert.match(gateway, /normalizeGatewayAudioRenditions\(\s*gatewayBody\.audioRenditions,\s*audioStreamIndex/);
  assert.match(gateway, /normalizeGatewayMultiAudioHls\(\s*gatewayBody\.multiAudioHls,\s*normalizedAudioRenditions,\s*audioStreamIndex/);
  assert.doesNotMatch(gateway, /gatewayHints\.(?:audioRenditions|multiAudioHls)|playbackHint\.(?:audioRenditions|multiAudioHls)/);
  assert.match(gateway, /audioRenditions,[\s\S]*multiAudioHls,[\s\S]*codecProfile/);

  const response = between(
    'const gatewaySessionResponse =',
    '\nasync function startPlaybackLanguageValidation(',
  );
  assert.match(response, /audioRenditions: gateway\.audioRenditions \?\? null/);
  assert.match(response, /audio_renditions: gateway\.audioRenditions \?\? null/);
  assert.ok((response.match(/audioRenditions: gateway\.audioRenditions \?\? null/g) || []).length >= 2);
  assert.match(response, /multiAudioHls: gateway\.multiAudioHls \?\? null/);
  assert.match(response, /multi_audio_hls: gateway\.multiAudioHls \?\? null/);
  assert.ok((response.match(/multiAudioHls: gateway\.multiAudioHls \?\? null/g) || []).length >= 2);
});

test('the Edge preserves a complete muxed-mono Gateway contract and binds it to the exact stream', () => {
  const { normalize, normalizeMetadata } = loadNormalizer();
  const renditions = normalize([], 1);
  assert.deepEqual(JSON.parse(JSON.stringify(renditions)), []);
  const metadata = {
    protocol: 1,
    enabled: false,
    reason: 'audio_track_count_below_minimum',
    maxAudioRenditions: 12,
    sourceTrackCount: 1,
    preparedTrackCount: 0,
    masterPlaylist: 'playlist.m3u8',
    videoPlaylist: 'playlist.m3u8',
    defaultHlsIndex: null,
    defaultStreamIndex: null,
  };
  const codecProfile = {
    audioTracks: [{ index: 1, language: 'eng', codec: 'eac3', channels: 2 }],
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeMetadata(metadata, renditions, 1, codecProfile))),
    metadata,
  );

  const invalid = [
    [{ ...metadata, sourceTrackCount: 2 }, renditions, 1, codecProfile],
    [{ ...metadata, preparedTrackCount: 1 }, renditions, 1, codecProfile],
    [{ ...metadata, defaultStreamIndex: 1 }, renditions, 1, codecProfile],
    [metadata, renditions, 2, codecProfile],
    [metadata, renditions, 1, { audioTracks: [] }],
    [metadata, renditions, 1, { audioTracks: [{ index: 2 }] }],
    [metadata, null, 1, codecProfile],
  ];
  for (const args of invalid) assert.equal(normalizeMetadata(...args), null);
});

test('the Edge drops the whole rendition map on any cardinality, index, label or codec mismatch', () => {
  const { normalize } = loadNormalizer();
  const variants = [
    [valid.slice(0, 1), 2],
    [[valid[0], { ...valid[1], hlsIndex: 2 }], 5],
    [[valid[0], { ...valid[1], streamIndex: 2 }], 5],
    [[valid[0], { ...valid[1], language: 'French' }], 5],
    [[valid[0], { ...valid[1], title: `bad\u0000title` }], 5],
    [[valid[0], { ...valid[1], title: 'x'.repeat(97) }], 5],
    [[valid[0], { ...valid[1], sourceChannels: 65 }], 5],
    [[valid[0], { ...valid[1], outputChannels: 6 }], 5],
    [[valid[0], { ...valid[1], codec: 'mp3' }], 5],
    [valid, 9],
  ];
  for (const [renditions, selected] of variants) {
    assert.equal(normalize(renditions, selected), null);
  }
});

test('the Edge accepts the full bounded Gateway cohort instead of truncating it at the obsolete eight-track cap', () => {
  const { normalize, normalizeMetadata } = loadNormalizer();
  const cohort = Array.from({ length: 12 }, (_, hlsIndex) => ({
    hlsIndex,
    streamIndex: hlsIndex + 1,
    language: hlsIndex % 2 === 0 ? 'eng' : 'fra',
    title: `Provider track ${hlsIndex + 1}`,
    sourceChannels: 2,
    outputChannels: 2,
    codec: 'aac',
  }));
  const normalized = normalize(cohort, 12);
  assert.equal(normalized.length, 12);
  const metadata = {
    ...validMetadata,
    sourceTrackCount: 12,
    preparedTrackCount: 12,
    defaultHlsIndex: 11,
    defaultStreamIndex: 12,
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeMetadata(metadata, normalized, 12))),
    metadata,
  );
});

test('the Edge drops the whole multi-audio topology on any diagnostics or default-stream mismatch', () => {
  const { normalize, normalizeMetadata } = loadNormalizer();
  const normalized = normalize(valid, 5);
  assert.ok(normalized);
  const variants = [
    { ...validMetadata, protocol: 2 },
    { ...validMetadata, enabled: false },
    { ...validMetadata, reason: 'disabled' },
    { ...validMetadata, maxAudioRenditions: 1 },
    { ...validMetadata, maxAudioRenditions: 33 },
    { ...validMetadata, sourceTrackCount: 1 },
    { ...validMetadata, preparedTrackCount: 1 },
    { ...validMetadata, preparedTrackCount: 3 },
    { ...validMetadata, masterPlaylist: 'other.m3u8' },
    { ...validMetadata, videoPlaylist: 'playlist.m3u8' },
    { ...validMetadata, defaultHlsIndex: 0 },
    { ...validMetadata, defaultStreamIndex: 2 },
  ];
  for (const metadata of variants) {
    assert.equal(normalizeMetadata(metadata, normalized, 5), null);
  }
  assert.equal(normalizeMetadata(validMetadata, normalized, 2), null);
  assert.equal(normalizeMetadata(validMetadata, null, 5), null);

  const boundedCohortMetadata = { ...validMetadata, sourceTrackCount: 12 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeMetadata(boundedCohortMetadata, normalized, 5))),
    boundedCohortMetadata,
    'the source may expose more tracks than the bounded simultaneous HLS cohort',
  );
});
