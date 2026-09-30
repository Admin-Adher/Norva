'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { runStrictLidMultiExtract } = require('../services/media-gateway/src/strict-lid-multi-extract');
const { parsePcm16Wav } = require('../services/media-gateway/src/strict-lid-audio-evidence');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');

// Exercise real MP4 seeks, including a valid movie whose audio ends before its
// video. A successful demuxer exit alone must never certify the later windows.
test('native MP4 timeline distinguishes complete audio from a shorter audio track',
    { skip: process.env.NORVA_CAPTURE_REAL_FFMPEG !== '1', timeout: 120000 }, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-mp4-timeline-'));
        const server = http.createServer();
        let bytes;
        t.after(async () => {
            server.closeAllConnections();
            if (server.listening) await new Promise(resolve => server.close(resolve));
            await fs.rm(root, { recursive: true, force: true });
        });
        server.on('request', (req, res) => {
            const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || 'bytes=0-');
            if (!match) { res.writeHead(400); res.end(); return; }
            const start = Number(match[1]);
            const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
            if (start > end) { res.writeHead(416); res.end(); return; }
            const body = bytes.subarray(start, end + 1);
            res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
                'Content-Length': body.length, 'Accept-Ranges': 'bytes', Connection: 'close' });
            res.end(body);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        for (const audioDuration of [600, 300]) {
            const source = path.join(root, `source-${audioDuration}.mp4`);
            await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=1:d=600',
                '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${audioDuration}`,
                '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-b:a', '16k',
                '-movflags', '+faststart', source], { timeout: 60000 });
            bytes = await fs.readFile(source);
            const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
                '-of', 'json', source])).stdout);
            assert.equal(Number(probe.format.duration), 600);
            assert.equal(Number(probe.streams.find(s => s.codec_type === 'audio').duration), audioDuration);
            const results = [];
            for (let ordinal = 1; ordinal <= 6; ordinal++) {
                const plan = planStrictSpeechWindow(600, ordinal);
                const destination = path.join(root, 'capture.wav');
                const result = await runStrictLidMultiExtract({ bin: 'ffmpeg',
                    inputUrl: `http://127.0.0.1:${server.address().port}/strict-lid/timeline`,
                    outputs: [{ index: 1, path: destination }], startSeconds: plan.searchStartSeconds,
                    durationSeconds: plan.searchDurationSeconds, timeoutMs: 10000 });
                assert.equal(result.ok, true);
                const wav = await fs.readFile(destination);
                if (audioDuration === 600 || ordinal <= 3) {
                    assert.ok(parsePcm16Wav(wav).durationSeconds >= 59);
                    results.push('valid');
                } else {
                    assert.throws(() => parsePcm16Wav(wav), { code: 'STRICT_LID_AUDIO_INVALID_DATA' });
                    results.push('invalid-data');
                }
            }
            t.diagnostic(JSON.stringify({ synthetic: true, providerRequests: 0,
                formatDuration: 600, audioDuration, windows: results }));
        }
    });
