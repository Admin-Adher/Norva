'use strict';

// Run inside the Gateway image with the candidate bounded-hls-output.js
// mounted at /tmp/retained-bounded-hls-output.js. All media is generated here.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { boundedHlsArgs } = require('/tmp/retained-bounded-hls-output.js');
const { createHlsOutputAdmission, loopbackOutputEnv } = require('/app/src/hls-output-admission.js');

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-retained-hls-'));
    let admission;
    try {
        admission = await createHlsOutputAdmission({ root, targetSeconds: 2, maxBytes: 64 * 1024 ** 2 });
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
            '-c:a', 'aac', '-f', 'hls', '-hls_time', '2',
            ...boundedHlsArgs(true, admission, true),
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', admission.urlFor('segment-%05d.ts'),
            admission.urlFor('playlist.m3u8'),
        ];
        const child = spawn('ffmpeg', args, { env: loopbackOutputEnv(process.env), stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        clearTimeout(timeout);
        assert.equal(code, 0, stderr.replace(/http:\/\/[^\s]+/g, '<loopback>'));
        await admission.finish();
        const names = await fs.readdir(root);
        const segments = names.filter(name => /^segment-\d{5}\.ts$/.test(name)).sort();
        assert(segments.length >= 5, `too few segments: ${segments.length}`);
        assert.equal(segments[0], 'segment-00000.ts');
        assert.equal(segments.at(-1), `segment-${String(segments.length - 1).padStart(5, '0')}.ts`);
        const playlist = await fs.readFile(path.join(root, 'playlist.m3u8'), 'utf8');
        assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:EVENT/);
        assert.match(playlist, /#EXT-X-ENDLIST/);
        for (const name of segments) assert(playlist.includes(name), `${name} absent from playlist`);
        process.stdout.write(JSON.stringify({ result: 'PASS', segments: segments.length,
            files: names.length, bytes: admission.snapshot().bytes }) + '\n');
    } finally {
        await admission?.stop().catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().catch(error => { process.stderr.write(String(error?.message || error) + '\n'); process.exitCode = 1; });
