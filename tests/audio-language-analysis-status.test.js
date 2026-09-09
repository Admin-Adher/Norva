'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const locales = require('../i18n/locales.json');

function runtime() {
    const context = {
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
        navigator: { languages: ['en'] }, localStorage: { getItem: () => null, setItem() {} },
        Intl, console, setTimeout, clearTimeout,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['i18n.js', 'utils/mediaUtils.js', 'pages/MoviesPage.js', 'pages/SeriesPage.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
    }
    return context;
}

const unidentifiedByLocale = [
    'Language unidentified', 'Langue non identifiée', 'Idioma não identificado',
    'Idioma no identificado', 'भाषा की पहचान नहीं हुई', 'Dil belirlenemedi',
    'ভাষা শনাক্ত হয়নি', 'اللغة غير محددة', 'Bahasa belum teridentifikasi', 'Hindi natukoy ang wika',
];

test('missing, terminal, and synthetic pending states never promise an audio analysis in any locale', () => {
    const r = runtime();
    for (const [index, { code }] of locales.entries()) {
        r.NorvaI18n.setPreference(code);
        for (const validation of [undefined, '', 'pending', 'not_analyzed', 'failed', 'rejected', 'probed', 'verified']) {
            for (const job of [undefined, '', 'failed', 'completed', 'cancelled', 'rejected', 'unknown']) {
                const item = {
                    title: 'FR - Example', original_language: 'fr',
                    audio_language_validation_status: validation,
                    audio_language_validation_job_status: job,
                    audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: 'und' }],
                    audio_languages: ['und'],
                };
                assert.equal(r.MediaUtils.versionLanguageBadge(item), unidentifiedByLocale[index], `${code}/${validation}/${job} badge`);
                assert.equal(r.MediaUtils.versionDescriptor(item).headline, unidentifiedByLocale[index], `${code}/${validation}/${job} version`);
            }
        }
    }
});

test('only a real queued, retrying, or running job displays progress, including page details in every locale', () => {
    const r = runtime();
    for (const { code } of locales) {
        r.NorvaI18n.setPreference(code);
        for (const status of ['queued', 'retry_wait', 'running']) {
            const expected = r.NorvaI18n.t(status === 'running' ? 'ui_web_audio_identifying' : 'ui_web_5a9e8e2f6e65');
            assert.ok(expected && !expected.startsWith('ui_web_'), code);
            for (const key of ['audio_language_validation_job_status', 'audioLanguageValidationJobStatus']) {
                const item = { audio_language_validation_status: 'pending', [key]: status };
                const badge = r.MediaUtils.versionLanguageBadge(item);
                assert.equal(badge, expected, `${code}/${key}/${status}`);
                assert.equal(r.MediaUtils.versionDescriptor(item).headline, expected);
                assert.equal(r.MoviesPage.prototype.displayLanguageStatus(badge), expected);
                assert.equal(r.SeriesPage.prototype.displayLanguageStatus(badge), expected);
            }
        }
        assert.equal(r.MoviesPage.prototype.displayLanguageStatus(r.MediaUtils.versionLanguageBadge({})), r.NorvaI18n.t('ui_web_audio_language_unidentified'));
        assert.equal(r.SeriesPage.prototype.displayLanguageStatus(r.MediaUtils.versionLanguageBadge({})), r.NorvaI18n.t('ui_web_audio_language_unidentified'));
    }
});

test('observed exact-file languages remain authoritative while their own job runs', () => {
    const r = runtime();
    for (const { code } of locales) {
        r.NorvaI18n.setPreference(code);
        for (const validation of ['probed', 'verified']) {
            for (const job of ['queued', 'retry_wait', 'running', 'failed']) {
                const item = {
                    title: 'FR - Example',
                    audio_language_validation_status: validation,
                    audio_language_validation_job_status: job,
                    audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: 'spa' }],
                };
                const spanish = r.MediaUtils.languageDisplayFull('es');
                assert.equal(r.MediaUtils.versionLanguageBadge(item), spanish, `${code}/${validation}/${job}`);
                assert.equal(r.MediaUtils.versionDescriptor(item).headline, spanish);
            }
        }
    }
});

test('a file progresses from unidentified through a real job to its saved language or a terminal unknown result', () => {
    const r = runtime();
    r.NorvaI18n.setPreference('fr');
    const item = { audio_language_validation_status: 'pending' };
    assert.equal(r.MediaUtils.versionLanguageBadge(item), 'Langue non identifiée');
    item.audio_language_validation_job_status = 'queued';
    assert.equal(r.MediaUtils.versionLanguageBadge(item), 'Audio en attente');
    item.audio_language_validation_job_status = 'running';
    assert.equal(r.MediaUtils.versionLanguageBadge(item), 'Analyse en cours');
    item.audio_language_validation_job_status = 'failed';
    assert.equal(r.MediaUtils.versionLanguageBadge(item), 'Langue non identifiée');
    Object.assign(item, {
        audio_language_validation_job_status: 'completed', audio_language_validation_status: 'verified',
        audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: 'por' }],
    });
    assert.equal(r.MediaUtils.versionLanguageBadge(item), 'Portugais');
});

test('a nested sibling job cannot make the current untagged version look scheduled', () => {
    const r = runtime();
    const otherFile = { audio_language_validation_job_status: 'running', audio_languages: ['es'] };
    const currentFile = { title: 'ES - Example', defaultVariant: otherFile, variants: [otherFile] };
    assert.equal(r.MediaUtils.versionLanguageBadge(currentFile), 'Language unidentified');
    assert.equal(r.MediaUtils.versionDescriptor(currentFile).headline, 'Language unidentified');
});

test('existing reviewed provider declarations precede every job state without becoming confirmed audio', () => {
    const r = runtime();
    for (const { code } of locales) {
        r.NorvaI18n.setPreference(code);
        for (const job of [undefined, 'queued', 'retry_wait', 'running', 'completed', 'failed']) {
            const item = {
                title: 'ES-SUB Netflix Example', original_language: 'es', subtitle_languages: ['es'],
                provider_audio_languages: ['hi'], provider_audio_language_status: 'provider_declared',
                audio_language_validation_status: 'not_analyzed', audio_language_validation_job_status: job,
            };
            const expected = new Intl.DisplayNames([code], { type: 'language' }).of('hi');
            assert.equal(r.MediaUtils.versionLanguageBadge(item), expected, `${code}/${job}`);
            assert.equal(r.MediaUtils.versionDescriptor(item).headline, expected, `${code}/${job}`);
            assert.equal(r.MediaUtils.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'hi' }).audio.state, 'unknown');
            assert.deepEqual(Array.from(r.MediaUtils.providerAudioLanguages({ ...item, provider_audio_language_status: '' })), []);
        }
    }
});
