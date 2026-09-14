'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { resolveVideoEncoderConfig, videoEncoderInputArgs, videoEncoderOutputArgs } = require('../services/media-gateway/src/video-encoder');

// Run only in the private, network-disabled Linux VAAPI test container. No
// provider URL, credential, Gateway session or production configuration needed.
test('native finite TS: hardware decode preserves accurate 1080p/AAC resume output', {
    skip: process.env.NORVA_TS_VAAPI_DECODE_NATIVE !== '1', timeout: 180000,
}, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'norva-ts-decode-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = (bin, args) => new Promise((resolve, reject) => {
        const started = performance.now();
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let output = '', error = '';
        child.stdout.on('data', chunk => { output = (output + chunk).slice(-200000); });
        child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('close', code => {
            clearTimeout(timer);
            if (code !== 0) reject(Error(`local native fixture failed (${code}): ${error}`));
            else resolve({ output, ms: Math.round(performance.now() - started) });
        });
    });
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    const input = path.join(root, 'fixture.ts');
    await run(ffmpeg, ['-v','error','-y','-f','lavfi','-i','testsrc2=size=1920x1080:rate=24',
        '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','50','-c:v','libx264',
        '-threads','2','-preset','ultrafast','-g','288','-sc_threshold','0','-pix_fmt','yuv420p',
        '-bf','2','-c:a','aac','-ac','2','-f','mpegts',input]);
    const config = resolveVideoEncoderConfig({ MEDIA_GATEWAY_VIDEO_ENCODER: 'vaapi', MEDIA_GATEWAY_VAAPI_DECODE: 'true' });
    const results = [];
    let reference = null;
    for (const hardwareDecode of [false, true, false, true]) {
        const output = path.join(root, `resume-${results.length}.ts`);
        const encoded = await run(ffmpeg, ['-v','error','-y',
            ...videoEncoderInputArgs(config, true, { hardwareDecode }),
            '-i',input,'-ss','17','-t','30','-map','0:V:0','-map','0:a:0',
            ...videoEncoderOutputArgs(config, { hardwareDecode, forceAligned: true, targetSeconds: 2 }),
            '-c:a','aac','-fps_mode','passthrough','-f','mpegts',output]);
        const probe = JSON.parse((await run(ffprobe, ['-v','error','-count_frames','-show_entries',
            'stream=codec_type,codec_name,width,height,nb_read_frames,start_time,duration', '-of','json',output])).output);
        const video = probe.streams.find(s => s.codec_type === 'video');
        const audio = probe.streams.find(s => s.codec_type === 'audio');
        assert.equal(video?.width, 1920);
        assert.equal(video?.height, 1080);
        assert.equal(audio?.codec_name, 'aac');
        // A cut between 24 fps timestamps can yield 719 rather than 720 frames.
        assert.ok([719, 720].includes(Number(video.nb_read_frames)));
        assert.ok(Math.abs(Number(video.start_time) - Number(audio.start_time)) < 0.1);
        // MPEG-TS packet interleaving can differ even for identical A/V. Compare
        // decoded frames (including their timestamps), not mux packet ordering.
        const decoded = [];
        for (const type of ['v', 'a']) {
            const frames = await run(ffmpeg, ['-v','error','-i',output,'-map',`0:${type}:0`,
                ...(type === 'v' ? ['-pix_fmt','yuv420p'] : ['-c:a','pcm_s16le']), '-f','framemd5','-']);
            decoded.push(frames.output.split('\n').filter(line => line && !line.startsWith('#')).join('\n'));
        }
        const digest = crypto.createHash('sha256').update(decoded.join('\n')).digest('hex');
        const proof = { streams: probe.streams, digest };
        if (reference) assert.deepEqual(proof, reference, 'hardware decode must preserve decoded A/V frames and timestamps');
        else reference = proof;
        results.push({ hardwareDecode, elapsedMs: encoded.ms, frames: Number(video.nb_read_frames),
            rateX: Number((30000 / encoded.ms).toFixed(2)), bytes: fs.statSync(output).size });
    }
    console.log('finite TS local decoder comparison', JSON.stringify({ network: false, identicalDecodedMedia: true, results }));
});
