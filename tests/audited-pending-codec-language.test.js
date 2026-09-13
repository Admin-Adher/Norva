'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime() {
    const context = {window: {}, Intl, console, document: {documentElement: {lang: 'en'}}};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/utils/mediaUtils.js'), 'utf8'), context);
    return context.window.MediaUtils;
}

test('pending exact audio never revives codec kik as a confirmed language', () => {
    const utils = runtime();
    for (const field of ['codec_profile', 'codecProfile']) {
        const item = {
            audio_language_validation_status: 'pending', audio_tracks_scope: 'file',
            audio_tracks: [{index: 1, codec: 'aac', channels: 6}],
            audio_languages_scope: 'file', audio_languages_observed: true, audio_languages: [],
            [field]: {audioTracks: [{index: 1, language: 'kik', title: 'Audio 1'}]},
        };
        assert.equal(utils.versionLanguageBadge(item), 'Language unidentified');
        const descriptor = utils.versionDescriptor(item);
        assert.equal(descriptor.headline, 'Language unidentified');
        for (const preferredAudioLanguage of ['ki', 'hi', 'en']) {
            assert.notEqual(utils.analyzeLanguageCompatibility(item, {preferredAudioLanguage}).audio.state, 'confirmed');
        }
    }
});

test('fresh exact observed DE still outranks an NL supplier label', () => {
    const utils = runtime();
    const item = {raw_title: 'NL | Land of Mine', category_name: 'NL | VIAPLAY',
        audio_language_validation_status: 'probed', audio_tracks_scope: 'file',
        audio_tracks: [{index: 1, lang: 'de'}], audio_languages: ['de']};
    assert.equal(utils.versionLanguageBadge(item), 'German');
    assert.equal(utils.catalogLanguageInfo(item).headline, 'German');
});
