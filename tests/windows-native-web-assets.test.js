'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {nativePlayerWebAssets}=require('../scripts/native-player-web-assets.cjs');
const html=fs.readFileSync('public/app.html','utf8');

test('Windows exports the actual WatchPage SVG controls, including both playback states',()=>{
    const icons=nativePlayerWebAssets(html);
    assert.deepEqual(Object.keys(icons).sort(),['audio','back','backward','forward','fullscreen','pause','play','restart','speed','subtitles','volume'].sort());
    for(const icon of Object.values(icons)){
        assert.ok(icon.paths.length>0);
        for(const path of icon.paths)assert.ok(html.includes('d="'+path+'"'));
        if(icon.stroke)assert.ok(icon.strokeWidth>0);
    }
    assert.notDeepEqual(icons.play,icons.pause);
    assert.notDeepEqual(icons.backward,icons.forward);
});
test('a removed WatchPage control fails packaging instead of shipping an empty desktop button',()=>{
    assert.throws(()=>nativePlayerWebAssets(html.replace('id="watch-captions-btn"','id="missing"')),/Missing WatchPage control/);
});
