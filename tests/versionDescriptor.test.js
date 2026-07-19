'use strict';

// Version cards describe one provider FILE. Exact per-file probes are authoritative;
// title-level/grouped maps and provider market labels must never masquerade as audio.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;

const names = { s1: 'Strng IPTV 8K', s2: 'AtlasPro' };
const resolve = (id) => names[id] || '';
const mk = (raw, extra) => Object.assign({
    raw_title: raw,
    container_extension: 'mkv',
    sourceId: 's1',
    audio_language_validation_status: 'not_analyzed'
}, extra || {});
const desc = (item, siblings) => M.versionDescriptor(item, {
    siblings: siblings || [item],
    resolveSourceName: resolve
});

test('AR-SUBS means Arabic subtitles, never Arabic audio without a file probe', () => {
    const d = desc(mk('AR-SUBS - Something'));
    assert.strictEqual(d.headline, 'Audio pending');
    assert.match(d.meta, /ST AR · burned-in/);
    assert.doesNotMatch(d.headline, /Arabic/);
});

test('AR-SUBS with an exact English track leads with English', () => {
    const d = desc(mk('AR-SUBS - Something', {
        audio_language_validation_status: 'verified',
        audio_tracks_scope: 'file',
        audio_tracks: [{ index: 1, lang: 'eng' }]
    }));
    assert.strictEqual(d.headline, 'English');
    assert.match(d.meta, /ST AR · burned-in/);
    assert.strictEqual(d.audioSource, 'file');
});

test('tenant exact-file language evidence labels AR-SUBS without inventing a stream index', () => {
    const d = desc(mk('AR-SUBS - Something', {
        audio_language_validation_status: 'verified',
        audio_languages_scope: 'file',
        audio_languages_observed: true,
        audio_languages: ['eng'],
        subtitle_languages_scope: 'file',
        subtitle_languages_observed: true,
        subtitle_languages: []
    }));
    assert.strictEqual(d.headline, 'English');
    assert.match(d.meta, /ST AR · burned-in/);
    assert.strictEqual(d.audioSource, 'file-languages');
});

test('many exact-file language observations stay compact and keep platform secondary', () => {
    const d = desc(mk('NF - X', {
        audio_language_validation_status: 'verified',
        audio_languages_scope: 'file',
        audio_languages_observed: true,
        audio_languages: ['ara', 'cze', 'deu', 'eng', 'fre'],
        subtitle_languages_scope: 'file',
        subtitle_languages_observed: true,
        subtitle_languages: ['ara', 'cze', 'dan', 'deu', 'eng', 'fre']
    }));
    assert.strictEqual(d.headline, '5 audio languages');
    assert.match(d.meta, /^6 ST · Netflix ·/);
});

test('an exact observed-but-untagged file suppresses a misleading prefix guess', () => {
    const d = desc(mk('FR - X', {
        audio_language_validation_status: 'pending',
        audio_languages_scope: 'file',
        audio_languages_observed: true,
        audio_languages: []
    }));
    assert.strictEqual(d.headline, 'Audio pending');
    assert.doesNotMatch(d.headline, /French/);
});

test('a single exact French soundtrack and soft subtitles stay separate', () => {
    const d = desc(mk('FR - X', {
        audio_language_validation_status: 'verified',
        audio_tracks_scope: 'file',
        audio_tracks: [{ index: 1, lang: 'fre' }],
        subtitle_tracks_scope: 'file',
        subtitle_tracks: [{ index: 2, lang: 'fre' }, { index: 3, lang: 'fre' }]
    }));
    assert.strictEqual(d.headline, 'French');
    assert.match(d.meta, /^ST FR ·/);
});

test('large multi-audio Netflix file stays compact and Netflix is metadata', () => {
    const audioTracks = Array.from({ length: 22 }, (_, index) => ({
        index,
        lang: index === 0 ? 'eng' : ['fre', 'spa', 'deu', 'ita'][index % 4]
    }));
    const subtitleTracks = Array.from({ length: 32 }, (_, index) => ({
        index: 22 + index,
        lang: index % 2 ? 'fre' : 'eng'
    }));
    const d = desc(mk('NF - X', {
        audio_language_validation_status: 'verified',
        audio_tracks_scope: 'file',
        audio_tracks: audioTracks,
        subtitle_tracks_scope: 'file',
        subtitle_tracks: subtitleTracks
    }));
    assert.strictEqual(d.headline, '5 audio languages');
    assert.match(d.meta, /^32 ST · Netflix ·/);
});

test('non-empty tenant observation wins over a known-empty global track cache', () => {
    const d = desc(mk('AR-SUBS - Something', {
        audio_language_validation_status: 'verified',
        audio_tracks_scope: 'file',
        audio_probed_at: '2026-07-19T00:00:00.000Z',
        audio_tracks: [],
        audio_languages_scope: 'file',
        audio_languages_observed: true,
        audio_languages: ['eng']
    }));
    assert.strictEqual(d.headline, 'English');
    assert.strictEqual(d.audioSource, 'file-languages');
});

test('two or three exact soundtracks use compact language codes', () => {
    const d = desc(mk('X', {
        audio_language_validation_status: 'verified',
        audio_tracks_scope: 'file',
        audio_tracks: [
            { index: 0, lang: 'eng' },
            { index: 1, lang: 'fre' },
            { index: 2, lang: 'ara' }
        ]
    }));
    assert.strictEqual(d.headline, 'EN / FR / AR');
});

test('an unprobed language prefix remains pending instead of becoming a claim', () => {
    assert.strictEqual(desc(mk('FR - X')).headline, 'Audio pending');
    assert.strictEqual(desc(mk('EN - X')).headline, 'Audio pending');
});

test('missing, failed, and rejected validation states fail closed without prefix language guesses', () => {
    for (const status of [undefined, '', 'failed', 'rejected', 'unknown']) {
        const item = mk('DE - In the Hand of Dante');
        if (status === undefined) delete item.audio_language_validation_status;
        else item.audio_language_validation_status = status;

        const d = desc(item);
        assert.strictEqual(d.headline, 'Audio pending', `descriptor status=${String(status)}`);
        assert.doesNotMatch(`${d.headline} ${d.meta}`, /Likely|German/i);
        assert.strictEqual(
            M.versionLanguageBadge(item, {}),
            'Audio pending',
            `badge status=${String(status)}`
        );
        assert.doesNotMatch(M.versionLabel(item, 'Provider'), /Likely|German/i);
        assert.match(M.versionLabel(item, 'Provider'), /Audio pending/);
        assert.strictEqual(M.audioLanguageValidationStatus(item), 'not_analyzed');
    }
});

test('a probed exact-file language is displayable without claiming speech verification', () => {
    for (const status of ['probed', 'probed_union']) {
        const item = mk('DE - In the Hand of Dante', {
            audio_language_validation_status: status,
            audio_tracks_scope: 'file',
            audio_probed_at: '2026-07-19T00:00:00.000Z',
            audio_tracks: [{ index: 0, lang: 'deu' }]
        });

        const d = desc(item);
        assert.strictEqual(d.headline, 'German', status);
        assert.doesNotMatch(d.headline, /Likely/i);
        assert.strictEqual(M.versionLanguageBadge(item, {}), 'German', status);
        assert.strictEqual(
            M.versionLanguageBadge(item, { preferredAudioLanguage: 'de' }),
            'Audio DE',
            status
        );
        assert.match(M.versionLabel(item, 'Provider'), /German/);
        assert.doesNotMatch(M.versionLabel(item, 'Provider'), /Likely/);
    }
});

test('verified status without an exact language payload never falls back to a prefix', () => {
    const item = mk('DE - In the Hand of Dante', {
        audio_language_validation_status: 'verified'
    });
    const d = desc(item);

    assert.strictEqual(d.headline, 'Audio unknown');
    assert.doesNotMatch(`${d.headline} ${d.meta}`, /Likely|German/i);
    assert.strictEqual(M.versionLanguageBadge(item, {}), 'Audio unknown');
    assert.doesNotMatch(M.versionLabel(item, 'Provider'), /Likely|German/i);
});

test('a verified title union remains displayable without consulting release-name prefixes', () => {
    const item = mk('DE - In the Hand of Dante', {
        audio_language_validation_status: 'verified_union',
        audio_languages_scope: 'title',
        audio_languages: ['deu', 'eng']
    });

    assert.strictEqual(M.versionLanguageBadge(item, {}), 'Multi: DE/EN');
    assert.doesNotMatch(M.versionLanguageBadge(item, {}), /Likely/i);
});

test('Netflix and Nordic are never presented as observed audio', () => {
    const nf = desc(mk('NF - X'));
    assert.strictEqual(nf.headline, 'Audio pending');
    assert.match(nf.meta, /Netflix/);

    const nordic = desc(mk('X', { category_name: 'NORDIC FILM NEW RELEASE' }));
    assert.strictEqual(nordic.headline, 'Audio pending');
    assert.match(nordic.meta, /Nordic/);
});

test('a grouped title track map cannot contaminate a child variant', () => {
    const item = mk('AR-SUBS - X', {
        variant_count: 12,
        audio_tracks_scope: 'title',
        audio_tracks: [{ index: 1, lang: 'fre' }],
        audio_languages: ['en', 'fr']
    });
    const d = desc(item);
    assert.strictEqual(d.headline, 'Audio pending');
    assert.doesNotMatch(d.headline, /French/);
    const compatibility = M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'fr' });
    assert.strictEqual(compatibility.audio.state, 'unknown');
    assert.strictEqual(compatibility.audio.source, 'provider_aggregate');
});

test('codec-profile tracks are safe because the profile belongs to the exact variant', () => {
    const d = desc(mk('NF - X', {
        audio_language_validation_status: 'verified',
        codec_profile: {
            audioTracks: [{ index: 0, lang: 'eng' }, { index: 1, lang: 'fre' }]
        }
    }));
    assert.strictEqual(d.headline, 'EN / FR');
});

test('quality is a badge and noise prefixes never leak into the headline', () => {
    const quality = desc(mk('EN - One Last Adventure 4K (2026)'));
    assert.strictEqual(quality.headline, 'Audio pending');
    assert.strictEqual(quality.badge, '4K');

    for (const raw of ['PREFIX - Oscar Shaw', 'TOP - Some Title']) {
        const d = desc(mk(raw));
        assert.strictEqual(d.headline, 'Audio pending');
        assert.doesNotMatch(d.headline + d.meta, /PREFIX|TOP/);
    }
});

test('a null sibling does not throw and fluidity tier remains available', () => {
    const item = mk('EN - X');
    assert.doesNotThrow(() => M.versionDescriptor(item, {
        siblings: [item, null, undefined],
        resolveSourceName: resolve
    }));
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'direct' }).tier.cls, 'tier-direct');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'video_transcode' }).tier.cls, 'tier-transcode');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'unknown' }).tier, null);
});
