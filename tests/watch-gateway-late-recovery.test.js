'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const verify = require('./fixtures/gateway-late-recovery');
test('late segments revive a timed-out automatic pause, never a viewer pause or obsolete attempt', async () => {
    class Hls {
        static Events = Object.fromEntries(['MEDIA_ATTACHED','AUDIO_TRACKS_UPDATED','AUDIO_TRACK_SWITCHED','SUBTITLE_TRACKS_UPDATED','SUBTITLE_TRACK_SWITCH','MANIFEST_PARSED','ERROR','BUFFER_APPENDED'].map(key => [key,key]));
        static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
        constructor() { this.handlers = new Map(); this.audioTracks = []; }
        on(event, callback) { this.handlers.set(event, callback); }
        emit(event, data) { return this.handlers.get(event)?.(event, data); }
        loadSource() {} attachMedia() {}
    }
    const context = { window: {}, Hls, console, clearTimeout, setTimeout: callback => { queueMicrotask(callback); return 0; } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/pages/WatchPage.js'),'utf8'),context);
    const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
    assert.equal(await verify(context.window.WatchPage,Hls,tick), 'ok');
});
