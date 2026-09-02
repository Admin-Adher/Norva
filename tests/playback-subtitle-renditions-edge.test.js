'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'norva-playback', 'index.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadNormalizers() {
  let block = between(
    'function normalizeGatewaySubtitleLanguage(',
    '\nfunction normalizeCodecProfileTracks(',
  );
  block = block
    .replace('function normalizeGatewaySubtitleLanguage(value: unknown)', 'function normalizeGatewaySubtitleLanguage(value)')
    .replace('function isExactGatewayTextSubtitleCodec(value: unknown)', 'function isExactGatewayTextSubtitleCodec(value)')
    .replace(
      'function normalizeGatewaySubtitleRenditions(value: unknown, codecProfileValue: unknown = null)',
      'function normalizeGatewaySubtitleRenditions(value, codecProfileValue = null)',
    )
    .replace('const normalized: JsonRecord[] = [];', 'const normalized = [];')
    .replace('new Set<number>()', 'new Set()')
    .replace(
      /function normalizeGatewayExactSubtitleHls\(\n  value: unknown,\n  renditions: JsonRecord\[\] \| null,\n  codecProfileValue: unknown = null,\n\)/,
      'function normalizeGatewayExactSubtitleHls(\n  value,\n  renditions,\n  codecProfileValue = null,\n)',
    );
  const context = {
    Number,
    Set,
    recordOrEmpty: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
  };
  vm.runInNewContext(
    `${block}; this.normalize = normalizeGatewaySubtitleRenditions; this.normalizeMetadata = normalizeGatewayExactSubtitleHls;`,
    context,
  );
  return context;
}

const profile = {
  subtitles: [
    {
      index: 4,
      language: 'eng',
      codec: 'subrip',
      subtitleType: 'text',
      extractable: true,
      default: true,
      forced: false,
      hearingImpaired: false,
    },
    {
      index: 7,
      language: 'fra',
      codec: 'ass',
      subtitleType: 'text',
      extractable: true,
      default: false,
      forced: true,
      hearingImpaired: true,
    },
  ],
};

const renditions = [
  {
    hlsIndex: 0,
    streamIndex: 4,
    language: 'eng',
    title: 'English',
    sourceCodec: 'subrip',
    outputCodec: 'webvtt',
    default: true,
    forced: false,
    hearingImpaired: false,
    playlistName: 'subtitle_0.m3u8',
    segmentPattern: 'subtitle_0-%05d.vtt',
  },
  {
    hlsIndex: 1,
    streamIndex: 7,
    language: 'fra',
    title: 'Français forcé',
    sourceCodec: 'ass',
    outputCodec: 'webvtt',
    default: false,
    forced: true,
    hearingImpaired: true,
    playlistName: 'subtitle_1.m3u8',
    segmentPattern: 'subtitle_1-%05d.vtt',
  },
];

const metadata = {
  protocol: 1,
  enabled: true,
  cacheEligible: true,
  reason: 'enabled',
  maxRenditions: 8,
  sourceTrackCount: 2,
  preparedTrackCount: 2,
};

test('Edge preserves only the complete exact Gateway WebVTT topology', () => {
  const { normalize, normalizeMetadata } = loadNormalizers();
  const normalized = normalize(renditions, profile);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), renditions);
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeMetadata(metadata, normalized, profile))),
    metadata,
  );

  const gateway = between('async function createGatewaySession(', '\nasync function requestGatewaySession(');
  assert.match(gateway, /normalizeGatewaySubtitleRenditions\(\s*gatewayBody\.subtitleRenditions/);
  assert.match(gateway, /normalizeGatewayExactSubtitleHls\(\s*gatewayBody\.exactSubtitleHls/);
  assert.match(gateway, /subtitleRenditions,[\s\S]*exactSubtitleHls,[\s\S]*startupPolicy/);

  const response = between('const gatewaySessionResponse =', '\nasync function startPlaybackLanguageValidation(');
  assert.ok((response.match(/subtitleRenditions: gateway\.subtitleRenditions \?\? null/g) || []).length >= 2);
  assert.ok((response.match(/exactSubtitleHls: gateway\.exactSubtitleHls \?\? null/g) || []).length >= 2);
});

test('Edge preserves a bounded exact playback cohort without marking it cache complete', () => {
  const { normalize, normalizeMetadata } = loadNormalizers();
  const partialProfile = {
    subtitles: [
      profile.subtitles[0],
      {
        index: 6,
        language: 'deu',
        codec: 'subrip',
        subtitleType: 'text',
        extractable: true,
        default: false,
        forced: false,
        hearingImpaired: false,
      },
      profile.subtitles[1],
    ],
  };
  const partial = normalize(renditions, partialProfile);
  assert.deepEqual(JSON.parse(JSON.stringify(partial)), renditions,
    'renditions bind by absolute stream identity, not codec-profile array position');
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeMetadata({
      ...metadata,
      cacheEligible: false,
      reason: 'enabled-partial',
      sourceTrackCount: 3,
      preparedTrackCount: 2,
    }, partial, partialProfile))),
    {
      ...metadata,
      cacheEligible: false,
      reason: 'enabled-partial',
      sourceTrackCount: 3,
      preparedTrackCount: 2,
    },
  );
});

test('Edge drops every stale, contradictory or non-text subtitle graph as one unit', () => {
  const { normalize, normalizeMetadata } = loadNormalizers();
  const renditionVariants = [
    [renditions[0], { ...renditions[1], hlsIndex: 2 }],
    [renditions[0], { ...renditions[1], streamIndex: 4 }],
    [renditions[0], { ...renditions[1], language: 'eng' }],
    [renditions[0], { ...renditions[1], sourceCodec: 'pgssub' }],
    [renditions[0], { ...renditions[1], outputCodec: 'subrip' }],
    [renditions[0], { ...renditions[1], default: true }],
    [renditions[0], { ...renditions[1], playlistName: '../subtitle_1.m3u8' }],
  ];
  for (const value of renditionVariants) assert.equal(normalize(value, profile), null);
  assert.equal(normalize(renditions, { subtitles: [profile.subtitles[0]] }), null);

  const normalized = normalize(renditions, profile);
  assert.ok(normalized);
  const metadataVariants = [
    { ...metadata, protocol: 2 },
    { ...metadata, enabled: false },
    { ...metadata, cacheEligible: false },
    { ...metadata, reason: 'partial' },
    { ...metadata, maxRenditions: 1 },
    { ...metadata, sourceTrackCount: 1 },
    { ...metadata, preparedTrackCount: 1 },
  ];
  for (const value of metadataVariants) {
    assert.equal(normalizeMetadata(value, normalized, profile), null);
  }
  assert.equal(normalizeMetadata(metadata, null, profile), null);
});
