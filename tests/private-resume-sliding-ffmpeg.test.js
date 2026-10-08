'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createHlsOutputAdmission, loopbackOutputEnv } = require('../services/media-gateway/src/hls-output-admission');
const { boundedHlsArgs } = require('../services/media-gateway/src/bounded-hls-output');
const { PrivateResumeHlsCache, parseResumeMediaPlaylist } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');

// Opt-in: real production FFmpeg in a network-isolated, unprivileged canary.
test('real FFmpeg sliding publication, cached A/V/subtitles and continuation decode', {
    skip: process.env.NORVA_SLIDING_FFMPEG_PROOF !== '1', timeout: 120000,
}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-sliding-proof-'));
    const admissions = [], retained = new Map(); let failures = 0;
    async function encode(label, duration) {
        const dir = path.join(root, label); await fs.mkdir(dir);
        let admission, snapshot = '';
        const io = { ...fs, rename: async (from, to) => {
            await fs.rename(from, to);
            const name = path.basename(to);
            if (label === 'continuation' && /^segment-000[01]\d.ts$/.test(name)) retained.set(name, await fs.readFile(to));
            if (name === 'video.m3u8') {
                const text = await fs.readFile(to, 'utf8'), parsed = parseResumeMediaPlaylist(text);
                if (parsed?.sequence === 0 && parsed.segments.length === 16) snapshot = text;
                if (parsed) admission.served(parsed.segments.at(-1).name);
            }
        } };
        admission = await createHlsOutputAdmission({ root: dir, io, resumeRetentionBytes:64 * 1024 ** 2,
            onFailure: () => failures++ }); admissions.push(admission);
        const child = spawn('ffmpeg', ['-v','error','-nostdin','-f','lavfi','-i',`testsrc2=size=128x128:rate=2:duration=${duration}`,
            '-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration}`,
            '-c:v','libx264','-threads','1','-preset','ultrafast','-g','8','-keyint_min','8','-sc_threshold','0',
            '-c:a','aac','-b:a','48k','-f','hls','-hls_time','4', ...boundedHlsArgs(true, admission),
            '-hls_segment_filename', admission.urlFor('segment-%05d.ts'), admission.urlFor('video.m3u8')],
            { env: loopbackOutputEnv(), stdio: ['ignore','ignore','pipe'] });
        let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
        const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
        try { assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), 0, stderr); }
        finally { clearTimeout(timer); await admission.finish(); }
        return { dir, admission, snapshot, text: await fs.readFile(path.join(dir, 'video.m3u8'), 'utf8') };
    }
    try {
        const first = await encode('first', 600), parsed = parseResumeMediaPlaylist(first.text);
        assert.ok(parsed.sequence > 0); assert.equal(parsed.segments.length, 64);
        assert.equal(first.admission.resumePlaylistClock.originFor('video.m3u8', first.text), parsed.sequence * 4);
        const cache = new PrivateResumeHlsCache();
        const binding = privateResumeBinding({ ownerKey:'a'.repeat(64), sourceUrl:'https://fixture.invalid/movie.mkv',
            sourceId:'fixture', sourceRevision:'1', fileSizeBytes:1000000, profile:'video=aac,subtitle=2' });
        const observed = { fileSizeBytes:1000000, validator:{kind:'etag',value:'"fixture"'}, effectiveUrlIdentitySha256:'b'.repeat(64) };
        await fs.writeFile(path.join(first.dir, 'subtitle_0.m3u8'), '#EXTM3U\n#EXTINF:600,\nsubtitle_0-00001.vtt\n#EXT-X-ENDLIST\n');
        await fs.writeFile(path.join(first.dir, 'subtitle_0-00001.vtt'), 'WEBVTT\n\n00:05:18.000 --> 00:05:24.000\nCrossing caption\n');
        const readAsset = async (name, limit) => { const b = await fs.readFile(path.join(first.dir,name)); return b.length <= limit ? b : null; };
        assert.equal(await cache.capture({ binding, observed, position:320, actualStartOffset:0,
            playlist:first.text.replace(/^#EXT-X-ENDLIST\s*$/gm,''), playlistName:'video.m3u8',
            playlistClock:first.admission.resumePlaylistClock, readAsset,
            subtitleRenditions:[{playlistName:'subtitle_0.m3u8',streamIndex:2}] }), true, cache.publicStatus().lastCaptureRejection);
        const lease = cache.acquire(binding,320,observed);
        assert.equal(lease.start,316); assert.equal(lease.end,368);
        assert.ok(first.admission.snapshot().resumeRetainedBytes > 0);
        assert.ok(first.admission.snapshot().bytes <= first.admission.snapshot().maxBytes);
        assert.match(lease.asset('resume-subtitle_0-0.vtt').toString(), /Crossing caption/);
        const continuation = await encode('continuation',280);
        const combined = lease.playlist(continuation.snapshot);
        const merged = path.join(root,'merged'); await fs.mkdir(merged);
        await fs.writeFile(path.join(merged,'playlist.m3u8'),combined+'#EXT-X-ENDLIST\n');
        for (const name of combined.split('\n').filter(x => x.endsWith('.ts'))) {
            await fs.writeFile(path.join(merged,name), name.startsWith('resume-') ? lease.asset(name) : retained.get(name));
        }
        const cachedText = lease.playlist('') + '#EXT-X-ENDLIST\n';
        await fs.writeFile(path.join(merged,'cached.m3u8'),cachedText);
        await fs.writeFile(path.join(merged,'continuation.m3u8'),continuation.snapshot+'#EXT-X-ENDLIST\n');
        const decode = (name, strict) => spawnSync('ffmpeg',['-v','warning', ...(strict ? ['-xerror'] : []),
            '-err_detect','explode','-protocol_whitelist','file,crypto,data', '-i',path.join(merged,name),
            '-map','0:v:0','-map','0:a:0','-f','framehash','-'],{timeout:30000,encoding:'utf8'});
        // Each encoder's transport sequence must decode strictly on its own.
        // FFmpeg 5's HLS demuxer flags the TS continuity-counter reset at an
        // explicit HLS splice as a corrupt INPUT packet. Keep that diagnostic;
        // it is distinct from decoder failures or missing decoded video frames.
        for (const name of ['cached.m3u8','continuation.m3u8']) {
            const result = decode(name,true); assert.equal(result.status,0,result.stderr);
            assert.doesNotMatch(result.stderr,/corrupt|error|invalid/i);
        }
        const joined = decode('playlist.m3u8',false); assert.equal(joined.status,0,joined.stderr);
        const frames = joined.stdout.split('\n').filter(line => /^0,/.test(line));
        assert.equal(frames.length,232,'all 116 seconds of video survive the explicit splice');
        assert.doesNotMatch(joined.stderr,/Error while decoding|Invalid data|non monotonically/i);
        const audio = JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','a:0',
            '-show_entries','stream=codec_name,profile','-of','json',path.join(merged,'resume-0.ts')],{encoding:'utf8'}));
        assert.equal(audio.streams[0].codec_name,'aac'); assert.equal(audio.streams[0].profile,'LC');
        const final = lease.playlist(continuation.text);
        assert.match(final, /MEDIA-SEQUENCE:19\n/); // 13 cached + 6 expired continuation segments
        assert.match(final, /DISCONTINUITY-SEQUENCE:1/); assert.doesNotMatch(final, /resume-\d+\.ts/);
        assert.ok(final.endsWith('#EXT-X-ENDLIST\n')); assert.equal(failures,0);
        lease.release(); cache.revokeOwner('a'.repeat(64)); assert.equal(cache.publicStatus().bytes,0);
    } finally {
        for (const a of admissions) await a.stop();
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        await fs.rm(root,{recursive:true,force:true});
    }
});
