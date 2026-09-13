'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const translations = require('../i18n/web-extra.json');
function load(language = 'fr') {
    const context = {window:{}, Intl, NorvaI18n:{language, t(key, args={}) {
        return (translations[key]?.[language] || args.defaultValue || key)
            .replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] ?? '');
    }}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/utils/mediaUtils.js'),'utf8'),context);
    return context.window.MediaUtils;
}
const codes = ['en','hi','ta','te'];
const metadata = title => ({raw_title:`IN ▎ ${title}`, category_name:'ASIA ▎ENGLISH HINDI DUBBED',
    item_type:'movie', audio_language_validation_status:'probed'});

test('the three reported four-language files expose language choices, not only a count', () => {
    const M=load();
    for (const title of ['Blink Twice','Blink Nat Geo','The Black Demon']) {
        for (const fields of [
            {audio_languages:codes,audio_languages_observed:true,audio_languages_scope:'file'},
            {audio_tracks:codes.map((lang,index)=>({index:index+1,lang})),audio_tracks_scope:'file'}
        ]) {
            const item={...metadata(title),...fields}, before=JSON.stringify(item);
            const info=M.catalogLanguageInfo(item);
            assert.equal(info.headline,'EN / HI / TA / TE');
            assert.equal(info.accessibleHeadline,codes.map(M.languageDisplayFull).join(' / '));
            assert.equal(info.languageStatus,'');
            assert.equal(M.versionDescriptor(item,{providerLanguageHints:true}).headline,info.headline);
            const html=M.languageBadgeHtml(info,'movie-language-badge');
            assert.ok(html.includes(`title="${M.escapeHtml(info.accessibleHeadline)}"`));
            assert.ok(html.includes(`aria-label="${M.escapeHtml(info.accessibleHeadline)}"`));
            assert.equal(JSON.stringify(item),before,'no audio evidence changed');
        }
    }
});

test('provider dubbing hints never replace a known contradictory track or an empty map', () => {
    const M=load();
    const item=metadata('The Blind');
    assert.equal(M.catalogLanguageInfo({...item,audio_tracks_scope:'file',audio_tracks:[{index:1,lang:'de'}]}).headline,'Allemand');
    const empty={...item,audio_tracks_scope:'file',audio_tracks:[],audio_probed_at:'2026-09-13T00:00:00Z'};
    assert.equal(M.catalogLanguageInfo(empty).audioSource,'file');
    assert.notEqual(M.catalogLanguageInfo(empty).headline,'Hindi');
    const unknown={raw_title:'IN ▎ The Blind',category_name:item.category_name};
    assert.equal(M.catalogLanguageInfo(unknown).headline,'Hindi');
    assert.equal(M.catalogLanguageInfo(unknown).audioSource,'provider-label');
    assert.equal(M.versionDescriptor(unknown).headline,'Langue non identifiée','strict evidence remains unchanged');
});
