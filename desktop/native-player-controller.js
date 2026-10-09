'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { createNativeInput } = require('./native-input');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function trackPreferences(value) {
    const result = {};
    for (const key of ['audio','subtitle']) {
        const raw = value?.[key]; if (!raw || typeof raw !== 'object') continue;
        const preference = {};
        if (/^[a-z0-9._:+/-]{1,160}$/i.test(raw.stableId || '')) preference.stableId = raw.stableId;
        if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(raw.language || '') && !['und','unk','mul'].includes(raw.language)) preference.language = raw.language.toLowerCase();
        if (key === 'subtitle' && raw.disabled === true) preference.disabled = true;
        if (Object.keys(preference).length) result[key] = preference;
    }
    return result;
}
function playbackRequest(value) {
    if (typeof value === 'string') {
        if (value.length > 32768) throw Error('INVALID_NATIVE_REQUEST');
        try { value = JSON.parse(value); } catch { throw Error('INVALID_NATIVE_REQUEST'); }
    }
    if (!value || !UUID.test(value.sessionId || '')) throw Error('INVALID_NATIVE_SESSION');
    const raw = String(value.url || '');
    let url;
    try { url = new URL(raw); } catch { throw Error('INVALID_NATIVE_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) throw Error('INVALID_NATIVE_URL');
    const seconds = Number(value.resumeSeconds ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw Error('INVALID_NATIVE_POSITION');
    if (value.mediaCache) throw Error('NATIVE_CACHE_TICKET_NOT_SUPPORTED');
    if (!['movie','episode','series'].includes(value.itemType)) throw Error('NATIVE_FINITE_VOD_REQUIRED');
    return { type: 'open', protocol: 1, sessionId: value.sessionId.toLowerCase(), url: url.href,
        title: String(value.title || 'Norva').replace(/[\x00-\x1f\x7f]/g, '').slice(0,240),
        resumeSeconds: seconds, playbackPreferences:trackPreferences(value.playbackPreferences),
        uiLanguage:/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(value.uiLanguage || '') ? value.uiLanguage : 'en',
        sourceId: String(value.sourceId || '').slice(0,128),
        itemId: String(value.itemId || '').slice(0,128), itemType: value.itemType };
}

// One native process owns one exact cloud session. Its OS exit (not a renderer
// notification) is the drain barrier. The next launch also waits for cloud close.
class NativePlayerController extends EventEmitter {
    constructor(executable, { spawnProcess = spawn, stopTimeoutMs = 5000, openInput = createNativeInput, host = null } = {}) {
        super(); this.executable = executable; this.spawnProcess = spawnProcess; this.stopTimeoutMs = stopTimeoutMs;
        this.active = null; this.unacknowledged = new Set(); this.pending = false;
        this.openInput = openInput; this.volume = 100; this.completed = new Map(); this.host = host;
    }
    async open(value) {
        const request = playbackRequest(value);
        if (this.pending || this.active || this.unacknowledged.size) throw Error('NATIVE_PREVIOUS_SESSION_NOT_CLOSED');
        this.pending = true; this.cancelOpening = false;
        let input;
        try {
            input = await this.openInput(request.url);
            if (this.cancelOpening) throw Error('NATIVE_OPEN_CANCELLED');
            const args = this.host ? ['--parent-window', this.host.handle, '--parent-process', String(this.host.processId)] : [];
            const child = this.spawnProcess(this.executable, args, { shell:false, windowsHide:true, stdio:['pipe','pipe','pipe'] });
            const state = { child, request, input, ready:false, progress:null, reason:'player_exited' };
            state.exited = new Promise(resolve => { state.resolveExit = resolve; });
            this.active = state;
            const lines = createInterface({ input:child.stdout });
            child.stderr.on('data', () => {}); // libVLC can print source URLs: never relay diagnostics.
            child.stdin.on('error', () => { void this.stop(); });
            lines.on('line', line => {
                if (this.active !== state || line.length > 8192) return;
                let event; try { event = JSON.parse(line); } catch { return; }
                if (event.type === 'ready' && event.protocol === 1 && !state.ready) {
                    state.ready = true; this.send(state, {...request,url:input.url,volume:this.volume}); return;
                }
                if (event.sessionId !== request.sessionId) return;
                if (event.type === 'fullscreen' && this.host) {
                    this.emit('fullscreen', event.enabled === true); return;
                }
                if (event.type === 'closed') { state.reason = String(event.reason || 'player_exited').slice(0,64); return; }
                if (event.type === 'preferences') {
                    this.emit('event',{type:'preferences',sessionId:request.sessionId,sourceId:request.sourceId,itemId:request.itemId,itemType:request.itemType,preferences:trackPreferences(event.preferences)});return;
                }
                if (event.type === 'volume') { if(Number.isInteger(event.value)&&event.value>=0&&event.value<=100)this.volume=event.value;return; }
                if (!['progress','playing','failed'].includes(event.type)) return;
                const positionSeconds = Number(event.positionSeconds), durationSeconds = Number(event.durationSeconds);
                if (!Number.isFinite(positionSeconds) || positionSeconds < 0 || positionSeconds > 86400
                    || !Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 86400) return;
                const safe = { type:event.type, sessionId:request.sessionId, sourceId:request.sourceId,
                    itemId:request.itemId, itemType:request.itemType, positionSeconds, durationSeconds,
                    savedAtMs:Date.now(), playing:event.playing === true };
                for (const key of ['decodedAudio','decodedVideo','displayedPictures','lostPictures','audioTrack','subtitleTrack']) {
                    if (Number.isSafeInteger(event[key]) && event[key] >= -1 && event[key] <= 1e9) safe[key] = event[key];
                }
                state.progress = safe; this.emit('event', safe);
            });
            let settled = false;
            const exited = async () => {
                if (settled) return; settled = true; clearTimeout(state.readyTimeout); lines.close();
                await input.stop();
                this.emit('diagnostic', {reason:state.reason, ready:state.ready,
                    progress:state.progress ? Object.fromEntries(['positionSeconds','durationSeconds','decodedAudio','decodedVideo','displayedPictures','lostPictures'].map(key => [key,state.progress[key]])) : null,
                    transport:input.counters || null});
                if (this.active === state) this.active = null;
                this.unacknowledged.add(request.sessionId);
                this.completed.set(request.sessionId,{sourceId:request.sourceId,itemId:request.itemId,itemType:request.itemType,reason:state.reason});
                state.resolveExit();
                this.emit('event', { type:'closed',sessionId:request.sessionId,reason:state.reason });
            };
            child.once('exit', exited); child.once('error', exited);
            state.readyTimeout = setTimeout(() => { if (!state.ready) void this.stop(); }, 15000);
            state.readyTimeout.unref?.();
            return { accepted:true, sessionId:request.sessionId };
        } catch (error) { await input?.stop(); throw error; }
        finally { this.pending = false; }
    }
    send(state, value) { if (!state.child.stdin.destroyed) state.child.stdin.write(JSON.stringify(value)+'\n'); }
    authorize(id) { if (this.active?.request.sessionId === id) this.send(this.active, { type:'authorize',sessionId:id }); }
    setFullscreen(enabled) { if (this.active?.ready) this.send(this.active, { type:'fullscreen', enabled:enabled === true }); }
    acknowledge(id) {
        if (!UUID.test(id || '') || !this.unacknowledged.delete(id)) return;
        const ended=this.completed.get(id); this.completed.delete(id);
        if(ended?.reason==='ended')this.emit('event',{type:'ended',sessionId:id,sourceId:ended.sourceId,itemId:ended.itemId,itemType:ended.itemType});
    }
    async stop() {
        this.cancelOpening = true;
        const state = this.active; if (!state) return;
        this.send(state, { type:'stop' });
        const kill = setTimeout(() => state.child.kill(), this.stopTimeoutMs);
        try { await state.exited; } finally { clearTimeout(kill); }
    }
}
module.exports = { NativePlayerController, playbackRequest, trackPreferences };
