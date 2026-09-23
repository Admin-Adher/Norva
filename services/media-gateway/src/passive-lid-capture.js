'use strict';

// Passive preparation has NO provider transport. Its only input is a bounded
// snapshot of closed segments already emitted by the viewer's own FFmpeg.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { captureBinding } = require('./strict-lid-capture-store');
const { planStrictSpeechWindow } = require('./strict-lid-speech-window');
const fail = code => Object.assign(new Error(code), { code });
const drain = Object.freeze({ providerDrained:true, providerDrainProtocol:1 });
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Eligibility only: these are the three-letter tags mapped by the existing
// Edge normalizeIsoLang contract, not predictions or new supported languages.
// A differential test executes that actual Edge function over its entire map.
const DECLARED_AUDIO_ALIASES = new Set((
    'afr aze glg guj kan kaz khm kir lat mal mar nep oci ori pan scr tgl yor zul '+
    'alb sqi ara arm hye baq eus ben bos bul bur mya cat chi zho cze ces dan dut nld '+
    'eng est fil fin fre fra geo kat ger deu gre ell heb hin hrv hun ice isl ind ita '+
    'jpn kor lav lit mac mkd may msa nob nor per fas pol por rum ron rus slo slk slv '+
    'spa srp swe tam tel tha tur ukr urd vie'
).split(' '));
function passiveTrackLanguageUnknown(value) {
    const code=String(value || '').toLowerCase().trim().split(/[-_]/)[0];
    return !code || ['un','und','mis','mul','zxx','nar'].includes(code)
        || (!/^[a-z]{2}$/.test(code) && !DECLARED_AUDIO_ALIASES.has(code));
}
const token = value => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
const channels = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number.parseInt(String(value), 10);
    return Number.isFinite(number) ? Math.max(0, Math.min(16, number)) : null;
};

// Same server-observation authority as the Edge strict-validation snapshot:
// a full Gateway probe does not need the EBML-prefix completeness flag. An
// in-band prefix still does. Never upgrade that flag or infer authority from
// the provider's filename/language hints. Identity remains the unchanged
// protocol-2 fingerprint below, including the actual completeness flag.
function passiveProfileEvidenceEligible(profile, now = Date.now()) {
    if (!profile || !Array.isArray(profile.audioTracks)
        || profile.audioTracks.some(track => !track || typeof track !== 'object' || Array.isArray(track))
        || !passiveProfileFingerprint(profile)) return false;
    const source = token(profile.probeSource);
    if (source !== 'gatewayprobe' && !(source === 'gatewayinband' && profile.metadataComplete === true)) return false;
    const container = token(profile.container);
    if (!['mkv','matroska','matroskawebm','mp4','mov','movmp4m4a3gp3g2mj2','m4v',
        'avi','ogg','flv','mpg','mpeg','ts','mpegts'].includes(container)) return false;
    const at = typeof profile.probedAt === 'string' ? Date.parse(profile.probedAt) : NaN;
    return Number.isFinite(now) && Number.isFinite(at) && at <= now + 300000
        && profile.durationSeconds >= 80 && profile.durationSeconds <= 86400;
}

// Must stay byte-for-byte compatible with the Edge protocol-2 structural
// profile payload. Tests compare actual Edge and Gateway implementations.
function passiveProfileFingerprint(profile) {
    if (!profile || !Array.isArray(profile.audioTracks) || !profile.audioTracks.length || profile.audioTracks.length > 128
        || !Number.isSafeInteger(profile.fileSizeBytes) || profile.fileSizeBytes <= 0
        || !Number.isFinite(profile.durationSeconds) || profile.durationSeconds <= 0) return null;
    const audioTracks = profile.audioTracks.map(track => ({ index:Number(track.index), codec:token(track.codec),
        channels:channels(track.channels), default:track.default === true })).sort((a,b) => a.index-b.index);
    if (audioTracks.some(t => !Number.isInteger(t.index) || t.index < 0 || t.index > 128)
        || new Set(audioTracks.map(t=>t.index)).size !== audioTracks.length) return null;
    return crypto.createHash('sha256').update(JSON.stringify({ protocol:2, metadataComplete:profile.metadataComplete === true,
        probeSource:token(profile.probeSource), probedAt:typeof profile.probedAt === 'string' ? profile.probedAt : '',
        container:token(profile.container), durationSeconds:Number(profile.durationSeconds), fileSizeBytes:profile.fileSizeBytes,
        audioTracks })).digest('hex');
}

function passiveCaptureBinding(input, ownerHash) {
    if (!/^[a-f0-9]{64}$/.test(ownerHash || '')) throw fail('PASSIVE_LID_OWNER_INVALID');
    const source = { ...captureBinding(input), jobId:'00000000-0000-4000-8000-000000000000', userId:`passive:${ownerHash}` };
    const digest = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
    source.jobId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
    return captureBinding(source);
}

function passiveResourcesAvailable(sample, activity, now=Date.now()) {
    return Boolean(sample && Number.isFinite(sample.at) && sample.at <= now && now-sample.at <= 10000
        && [sample.cpuRatio,sample.memoryRatio,sample.hostLoadRatio].every(n=>Number.isFinite(n) && n>=0)
        && sample.cpuRatio < 0.5 && sample.memoryRatio < 0.65 && sample.hostLoadRatio < 0.6
        && !activity.starting && !activity.foreground && !activity.benchmark);
}

function passiveWindowPlan(playlist, { startSeconds, durationSeconds, prefix } = {}) {
    if (typeof playlist !== 'string' || Buffer.byteLength(playlist) > 2 * 1024 * 1024
        || !Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds)
        || durationSeconds < 20 || durationSeconds > 60 || !/^(?:segment|video|audio_\d+)$/.test(prefix || '')) return null;
    const lines = playlist.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') return null;
    const segments = []; let pending = null; let elapsed = 0; let expected = 0; let declaredType = false;
    for (const line of lines.slice(1)) {
        if (line.startsWith('#EXTINF:')) {
            if (pending !== null || !/^#EXTINF:\d+(?:\.\d+)?,[^\r\n]*$/.test(line)) return null;
            pending = Number(line.slice(8).split(',')[0]);
            if (!(pending > 0 && pending <= 30)) return null;
        } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            if (line !== '#EXT-X-MEDIA-SEQUENCE:0' || expected !== 0) return null;
        } else if (/^#EXT-X-PLAYLIST-TYPE:(EVENT|VOD)$/.test(line)) declaredType = true;
        else if (/^#EXT-X-(?:VERSION|TARGETDURATION):\d+$/.test(line)
            || ['#EXT-X-INDEPENDENT-SEGMENTS','#EXT-X-ENDLIST'].includes(line)) continue;
        else if (line.startsWith('#')) return null; // keys, maps, gaps, discontinuities, URI extensions
        else {
            const match = /^(segment|video|audio_\d+)-(\d{5,8})\.ts$/.exec(line);
            if (!match || match[1] !== prefix || Number(match[2]) !== expected++ || pending === null) return null;
            const end = elapsed + pending;
            if (end > startSeconds && elapsed < startSeconds + durationSeconds) segments.push({ name:line, start:elapsed, end });
            elapsed = end; pending = null;
            if (expected > 30000 || segments.length > 128) return null;
        }
    }
    if (!declaredType || pending !== null || !segments.length || elapsed + 0.001 < startSeconds + durationSeconds) return null;
    return { segments, seekSeconds:startSeconds-segments[0].start, durationSeconds };
}

async function openRegular(root, name, maximum) {
    if (!path.isAbsolute(root) || !/^[a-zA-Z0-9_-]+\.(?:m3u8|ts)$/.test(name)) throw fail('PASSIVE_LID_PATH_INVALID');
    const resolved = path.resolve(root);
    const stat = await fsp.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(resolved) !== resolved) throw fail('PASSIVE_LID_PATH_INVALID');
    const file = path.join(resolved, name); const before = await fsp.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > maximum) throw fail('PASSIVE_LID_FILE_INVALID');
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev
        || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
        await handle.close(); throw fail('PASSIVE_LID_FILE_CHANGED');
    }
    return { handle, stat:opened };
}

async function readPlaylist(root, name) {
    const { handle, stat } = await openRegular(root, name, 2 * 1024 * 1024);
    try {
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length-offset, offset);
            if (!result.bytesRead) throw fail('PASSIVE_LID_FILE_CHANGED'); offset += result.bytesRead;
        }
        return new TextDecoder('utf-8', { fatal:true }).decode(bytes);
    } finally { await handle.close(); }
}

async function snapshotSegments(source, plan, output, alive) {
    const destination = await fsp.open(output, 'wx', 0o600); let total = 0;
    try {
        const buffer = Buffer.alloc(64 * 1024);
        for (const segment of plan.segments) {
            if (!alive()) throw fail('PASSIVE_LID_CANCELLED');
            const { handle, stat } = await openRegular(source.root, segment.name, MAX_MEDIA_BYTES-total);
            try {
                let offset = 0;
                while (offset < stat.size) {
                    if (!alive()) throw fail('PASSIVE_LID_CANCELLED');
                    const result = await handle.read(buffer, 0, Math.min(buffer.length,stat.size-offset), offset);
                    if (!result.bytesRead) throw fail('PASSIVE_LID_FILE_CHANGED');
                    let written = 0;
                    while (written < result.bytesRead) {
                        const part = await destination.write(buffer, written, result.bytesRead-written);
                        if (!part.bytesWritten) throw fail('PASSIVE_LID_WRITE_FAILED'); written += part.bytesWritten;
                    }
                    offset += result.bytesRead; total += result.bytesRead;
                }
                const after = await handle.stat();
                if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) throw fail('PASSIVE_LID_FILE_CHANGED');
            } finally { await handle.close(); }
        }
    } finally { await destination.close(); }
    return total;
}

function extractPassiveWav({ bin, input, output, plan, signal, alive, spawnImpl = spawn }) {
    // FFmpeg sees one private MPEG-TS file, never a mutable playlist, URL or
    // concat manifest. It cannot follow a remote child or select another file.
    if (![input,output].every(p=>path.isAbsolute(p || '')) || path.dirname(input) !== path.dirname(output)
        || path.basename(input) !== 'passive.ts' || path.basename(output) !== 'raw.wav') throw fail('PASSIVE_LID_PATH_INVALID');
    return new Promise(resolve => {
        let child; let terminal = false; let timer; let grace; let poll; let settled = false; let stderr = 0;
        const finish = processClosed => {
            if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); clearInterval(poll);
            signal?.removeEventListener('abort', stop); resolve({ ok:!terminal, processClosed });
        };
        const stop = () => {
            if (settled || terminal) return; terminal = true;
            grace = setTimeout(()=>finish(false),1000); try { child?.kill('SIGKILL'); } catch {}
        };
        if (signal?.aborted || !alive()) { terminal = true; finish(true); return; }
        try {
            child = spawnImpl(bin, ['-y','-hide_banner','-loglevel','error','-nostdin','-threads','1',
                '-protocol_whitelist','file,pipe','-format_whitelist','mpegts','-f','mpegts','-i',input,
                '-ss',String(plan.seekSeconds),'-map','0:a:0','-t',String(plan.durationSeconds),
                '-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav',output],
                { stdio:['ignore','ignore','pipe'], windowsHide:true });
        } catch { terminal = true; finish(true); return; }
        child.on('error',stop); child.once('close',code=>{ if(code !== 0) terminal=true; finish(true); });
        child.stderr?.on('data',chunk=>{ stderr+=chunk.length; if(stderr>16384) stop(); });
        signal?.addEventListener('abort',stop,{ once:true }); if(signal?.aborted) stop();
        timer=setTimeout(stop,8000); poll=setInterval(()=>{ if(!alive()) stop(); },100);
    });
}

function createPassiveLidCapture({ store, resolveSource, resourcesAvailable, bin, extract = extractPassiveWav }) {
    let active = false; let blocked = false; const stats = { prepared:0, misses:0, snapshotBytes:0 };
    const missesByReason = {};
    return Object.freeze({
        snapshot:()=>({ protocol:1, active, blocked, ...stats, missesByReason:{ ...missesByReason } }),
        async adopt(input) {
            // Only an already-authorized real user/job can adopt its own
            // precollected file window. No profile/window/model substitution.
            const binding=captureBinding(input);
            if(!UUID.test(binding.userId)) return false;
            const ownerHash=crypto.createHash('sha256').update(binding.userId).digest('hex');
            const sourceBinding=passiveCaptureBinding(binding,ownerHash);
            let reservation;
            try {
                const existing=await store.get(sourceBinding); if(!existing) return false;
                reservation=await store.reserve(binding);
                if(!reservation.cached) await store.put(binding,existing.wav,drain,reservation.token,{ expiresAt:existing.expiresAt });
                await store.remove(sourceBinding); return true;
            } catch { return false; }
            finally { await reservation?.release(); }
        },
        async capture(input, context, signal) {
            const binding=captureBinding(input);
            // Internal fixed codes only: never source names, paths, URLs or
            // extracted speech. An unavailable future window is not an ASR miss.
            const miss=reason=>{ stats.misses++; missesByReason[reason]=(missesByReason[reason]||0)+1;
                return { passiveProtocol:1,captured:false,...drain }; };
            const capacity=store.snapshot();
            // Reserve most of the shared buffer for active jobs. Restart cannot
            // evade this bound because it counts ALL restored records, not an
            // in-memory-only set of passive keys.
            if(active) return miss('already-active');
            if(blocked) return miss('extractor-not-closed');
            if(signal?.aborted) return miss('cancelled');
            if(!resourcesAvailable()) return miss('resource-pressure');
            if(capacity.entries+capacity.reservations>=8 || capacity.bytes>=16*1024*1024) return miss('capacity');
            active=true; let reservation;
            try {
                reservation=await store.reserve(binding);
                if(reservation.cached) {
                    const cached=await store.get(binding);
                    return cached ? { passiveProtocol:1,captured:true,sha256:cached.sha256,expiresAt:cached.expiresAt,...drain } : miss('cached-record-missing');
                }
                const source=resolveSource(binding,context);
                if(!source) return miss('source-not-current');
                const alive=()=>!signal?.aborted && resourcesAvailable() && source.isCurrent();
                const window=planStrictSpeechWindow(binding.durationSeconds,binding.windowOrdinal);
                const playlist=await readPlaylist(source.root,source.playlistName);
                const plan=passiveWindowPlan(playlist,{ startSeconds:window.searchStartSeconds,
                    durationSeconds:window.searchDurationSeconds,prefix:source.segmentPrefix });
                if(!plan) return miss('window-not-ready');
                if(!alive()) return miss('admission-changed');
                // Do not create/remove a private workspace on each timer tick
                // while the existing player has not received this window yet.
                return await store.withWorkspace(async output=>{
                    if(!alive()) return miss('admission-changed');
                    const inputPath=path.join(path.dirname(output),'passive.ts');
                    const bytes=await snapshotSegments(source,plan,inputPath,alive);
                    const destination=await fsp.open(output,'wx',0o600); await destination.close();
                    const result=await extract({ bin,input:inputPath,output,plan,signal,alive });
                    if(result.processClosed !== true) blocked=true;
                    if(blocked) return miss('extractor-not-closed');
                    if(!result.ok) return miss('extraction-failed');
                    if(!alive()) return miss('admission-changed');
                    const stat=await fsp.stat(output);
                    if(!stat.isFile() || stat.size<=0 || stat.size>3*1024*1024) return miss('audio-size-invalid');
                    const saved=await store.put(binding,await fsp.readFile(output),drain,reservation.token);
                    stats.prepared++; stats.snapshotBytes+=bytes;
                    return { passiveProtocol:1,captured:true,...saved,...drain };
                });
            } catch { return miss('input-or-store-rejected'); }
            finally { await reservation?.release(); active=false; }
        },
    });
}

module.exports={ passiveTrackLanguageUnknown,passiveProfileEvidenceEligible,passiveProfileFingerprint,passiveCaptureBinding,passiveResourcesAvailable,passiveWindowPlan,extractPassiveWav,createPassiveLidCapture };
