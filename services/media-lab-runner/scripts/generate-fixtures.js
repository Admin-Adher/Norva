'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FIXTURE_IDS } = require('../src/fixture-registry');
const { inferFfprobePath, verifyFixture } = require('./fixture-verifier');

const SERVICE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(SERVICE_ROOT, 'fixtures', 'manifest.json');
const DEFAULT_OUTPUT_ROOT = path.join(SERVICE_ROOT, 'fixtures', 'generated');

function readManifest() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const ids = Array.isArray(manifest.fixtures) ? manifest.fixtures.map((item) => item.id) : [];
    if (
        manifest.protocol !== 1
        || manifest.generatorVersion !== 'mkv-lab-fixtures-v2'
        || ids.length !== FIXTURE_IDS.length
        || ids.some((id, index) => id !== FIXTURE_IDS[index])
    ) throw new Error('MEDIA_LAB_FIXTURE_MANIFEST_INVALID');
    for (const item of manifest.fixtures) {
        if (
            (item.output !== null && (typeof item.output !== 'string' || path.basename(item.output) !== item.output))
            || typeof item.recipe !== 'string'
        ) throw new Error('MEDIA_LAB_FIXTURE_MANIFEST_INVALID');
    }
    return manifest;
}

function commonInputs(duration, size = '640x360', rate = '24') {
    return [
        '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
        '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:duration=${duration}`,
    ];
}

function stableOutput(outputPath) {
    return [
        '-map_metadata', '-1',
        '-metadata', 'creation_time=2026-08-17T00:00:00Z',
        '-metadata', 'title=Norva Media Lab deterministic fixture',
        '-fflags', '+bitexact',
        '-flags:v', '+bitexact',
        '-flags:a', '+bitexact',
        '-shortest', outputPath,
    ];
}

function h264Video({ openGop = false, level = '4.1', keyint = 48 } = {}) {
    return [
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level:v', level,
        '-x264-params', `keyint=${keyint}:min-keyint=${keyint}:scenecut=0:open-gop=${openGop ? 1 : 0}:repeat-headers=1`,
    ];
}

function recipeArgs(item, manifest, outputRoot) {
    if (!item.output) return Object.freeze({ state: 'response-only', args: null, outputPath: null, requires: [] });
    const outputPath = path.join(outputRoot, item.output);
    const duration = manifest.durationSeconds;
    const base = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
    let args;
    let state = 'ready';
    const requires = (item.requires || []).map((entry) => path.resolve(SERVICE_ROOT, 'fixtures', entry));
    switch (item.recipe) {
    case 'h264-closed-aac-v1':
        args = [...base, ...commonInputs(duration), ...h264Video(), '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2'];
        break;
    case 'h264-closed-ac3-v1':
        args = [...base, ...commonInputs(duration), ...h264Video(), '-c:a', 'ac3', '-ac', '6'];
        break;
    case 'h264-open-gop-v1':
        args = [...base, ...commonInputs(duration), ...h264Video({ openGop: true }), '-c:a', 'aac', '-ac', '2'];
        break;
    case 'h264-multi-audio-v1':
        args = [
            ...base,
            ...commonInputs(duration),
            '-f', 'lavfi', '-i', `sine=frequency=1200:sample_rate=48000:duration=${duration}`,
            '-f', 'lavfi', '-i', `sine=frequency=1400:sample_rate=48000:duration=${duration}`,
            '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:a:0',
            ...h264Video(), '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:a:2', 'aac',
        ];
        break;
    case 'hevc-eac3-cold-v1':
        args = [
            ...base, ...commonInputs(duration, '1280x720'),
            '-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le',
            '-x265-params', 'keyint=48:min-keyint=48:scenecut=0:repeat-headers=1',
            '-c:a', 'eac3', '-ac', '6',
        ];
        break;
    case 'h264-level52-v1':
        args = [
            // Keep the deliberately incompatible 120 fps/Level 5.2 stream long
            // enough for the real browser harness to perform a post-start seek.
            ...base, ...commonInputs(4, '1920x1080', '120'),
            ...h264Video({ level: '5.2', keyint: 120 }), '-refs', '12', '-c:a', 'aac', '-ac', '2',
        ];
        break;
    case 'h264-bad-timestamps-v1':
        args = [
            ...base, ...commonInputs(duration),
            '-vf', 'setpts=if(gte(N\\,48)\\,PTS-1/TB\\,PTS)', '-vsync', 'passthrough',
            ...h264Video(), '-c:a', 'aac', '-ac', '2',
        ];
        state = 'requires-post-generation-verification';
        break;
    case 'h264-pgs-v1':
        args = [
            ...base, ...commonInputs(duration), '-i', requires[0],
            '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0',
            ...h264Video(), '-c:a', 'aac', '-ac', '2', '-c:s', 'copy',
        ];
        state = 'requires-pinned-seed';
        break;
    default:
        throw new Error(`MEDIA_LAB_UNKNOWN_RECIPE:${item.recipe}`);
    }
    return Object.freeze({
        state,
        args: Object.freeze([...args, ...stableOutput(outputPath)]),
        outputPath,
        requires: Object.freeze(requires),
    });
}

function buildPlan(manifest = readManifest(), outputRoot = DEFAULT_OUTPUT_ROOT) {
    const root = path.resolve(outputRoot);
    return Object.freeze(manifest.fixtures.map((item) => {
        const recipe = recipeArgs(item, manifest, root);
        return Object.freeze({ id: item.id, recipe: item.recipe, ...recipe });
    }));
}

async function digestFile(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

async function spawnFfmpeg(binary, args) {
    await new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: 'inherit', windowsHide: true, shell: false });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`FFMPEG_FIXTURE_GENERATION_FAILED:${code ?? signal}`));
        });
    });
}

async function executePlan(plan, {
    ffmpegPath = process.env.MEDIA_LAB_FFMPEG_PATH || 'ffmpeg',
    ffprobePath = inferFfprobePath(ffmpegPath),
    verifyFixtureImpl = verifyFixture,
} = {}) {
    const generated = [];
    for (const item of plan) {
        if (item.state === 'response-only') continue;
        for (const required of item.requires) {
            const stat = await fsp.stat(required).catch(() => null);
            if (!stat?.isFile()) throw new Error(`MEDIA_LAB_PINNED_SEED_MISSING:${item.id}`);
        }
        await fsp.mkdir(path.dirname(item.outputPath), { recursive: true });
        await spawnFfmpeg(ffmpegPath, item.args);
        const attestation = await verifyFixtureImpl({
            id: item.id,
            filePath: item.outputPath,
            ffmpegPath,
            ffprobePath,
        });
        generated.push(Object.freeze({
            id: item.id,
            file: path.basename(item.outputPath),
            bytes: (await fsp.stat(item.outputPath)).size,
            sha256: await digestFile(item.outputPath),
            verificationRequired: false,
            verificationState: 'passed',
            attestation,
        }));
    }
    const lock = Object.freeze({
        protocol: 1,
        generatorVersion: 'mkv-lab-fixtures-v2',
        fixtures: generated,
    });
    if (generated.length > 0) {
        const root = path.dirname(plan.find((item) => item.outputPath)?.outputPath || DEFAULT_OUTPUT_ROOT);
        await fsp.writeFile(path.join(root, 'fixture-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'w' });
    }
    return lock;
}

async function main(argv = process.argv.slice(2)) {
    if (argv.length !== 1 || !['--plan', '--execute'].includes(argv[0])) {
        throw new Error('Usage: generate-fixtures.js --plan|--execute');
    }
    const plan = buildPlan();
    if (argv[0] === '--plan') {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
    }
    const lock = await executePlan(plan);
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${String(error?.message || 'fixture generation failed')}\n`);
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({
    readManifest,
    buildPlan,
    executePlan,
    main,
});
