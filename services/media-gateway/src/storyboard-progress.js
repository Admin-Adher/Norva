'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { storyboardEncodingArgs } = require('./storyboard-encoding');

const MAX_AGE_MS = 90 * 60_000;
const BATCH_SIZE = 10;
const MAX_BYTES = 32 * 1024 * 1024;

function storyboardPlan(duration) {
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 7200;
    const intervalSec = Math.max(10, Math.ceil(dur / 200));
    const count = Math.max(1, Math.min(200, Math.floor(dur / intervalSec) || 1));
    return { intervalSec, count, cols: 10, rows: Math.ceil(count / 10) };
}

// Private to one admitted job, never a cross-user/file cache. The queue is not
// durable: a gateway restart deliberately does NOT reuse these unvalidated files.
async function createProgress(job, now = Date.now()) {
    if (job.durableDir) {
        const dir = path.join(job.durableDir, 'frames');
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const saved = job.progress;
        if (!saved || saved.sourceBinding !== job.sourceBinding) {
            // Credentials/catalogue target changed: never combine frames from two sources.
            await fs.rm(dir, { recursive: true, force: true });
            await fs.mkdir(dir, { mode: 0o700 });
        }
        const compatible = saved?.sourceBinding === job.sourceBinding ? saved : null;
        const state = { dir, durable: true, plan: storyboardPlan(job.duration), next: 0,
            failures: compatible?.failures || 0, activeMs: compatible?.activeMs || 0,
            url: job.url, sourceBinding: job.sourceBinding, expiresAt: Infinity };
        // Discover committed frames even if the process died before saving next.
        await collectCompleted(state);
        return state;
    }
    // A crash loses the in-memory queue, not the obligation to reclaim its files.
    for (const name of await fs.readdir(os.tmpdir())) {
        if (!/^norva-storyboard-progress-[A-Za-z0-9]+$/.test(name)) continue;
        const candidate = path.join(os.tmpdir(), name);
        const stat = await fs.lstat(candidate).catch(() => null);
        if (stat?.isDirectory() && now - stat.birthtimeMs > MAX_AGE_MS + 120_000) {
            await disposeProgress({ dir: candidate });
        }
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-storyboard-progress-'));
    await fs.chmod(dir, 0o700);
    const state = { dir, plan: storyboardPlan(job.duration), next: 0, failures: 0,
        url: job.url, expiresAt: Math.min(now + MAX_AGE_MS, job.expiresAt || Infinity) };
    state.timer = setTimeout(() => { disposeProgress(state).catch(() => {}); }, Math.max(1, state.expiresAt - now));
    state.timer.unref?.();
    return state;
}

async function disposeProgress(state) {
    if (!state) return;
    clearTimeout(state.timer);
    // Only the internally-created directory is eligible, never a caller path.
    if (path.dirname(state.dir) !== os.tmpdir() || !path.basename(state.dir).startsWith('norva-storyboard-progress-')) {
        throw new Error('Invalid storyboard checkpoint directory');
    }
    await fs.rm(state.dir, { recursive: true, force: true });
}

function batchArgs(state, url, inputOptions = []) {
    const n = Math.min(BATCH_SIZE, state.plan.count - state.next);
    return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', ...inputOptions,
        '-ss', String(state.next * state.plan.intervalSec), '-i', url,
        '-map', '0:v:0', '-an', '-sn',
        '-vf', `setpts=PTS-STARTPTS,fps=1/${state.plan.intervalSec}:start_time=0,scale=212:120:force_original_aspect_ratio=decrease,pad=212:120:(ow-iw)/2:(oh-ih)/2`,
        '-frames:v', String(n), '-q:v', '5', '-threads', '1',
        '-f', 'image2', '-atomic_writing', '1', '-start_number', String(state.next),
        path.join(state.dir, 'frame-%03d.jpg')];
}

function assemblyArgs(state, outputPath) {
    return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-framerate', '1', '-start_number', '0', '-i', path.join(state.dir, 'frame-%03d.jpg'),
        '-vf', `tile=${state.plan.cols}x${state.plan.rows}:nb_frames=${state.plan.count}`,
        '-frames:v', '1', ...storyboardEncodingArgs(), outputPath];
}

async function collectCompleted(state) {
    let bytes = 0;
    for (const name of await fs.readdir(state.dir)) {
        bytes += (await fs.stat(path.join(state.dir, name))).size;
    }
    if (bytes > MAX_BYTES) throw new Error('Storyboard checkpoint size limit exceeded');
    // image2 renames each JPEG atomically: a killed process's .tmp is never a checkpoint.
    while (state.next < state.plan.count) {
        const file = path.join(state.dir, `frame-${String(state.next).padStart(3, '0')}.jpg`);
        const data = await fs.readFile(file).catch(() => null);
        if (!data) break;
        if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
            throw new Error('Incomplete storyboard checkpoint');
        }
        state.next++;
    }
    return state.next;
}

async function runProgressBatch(state, job, outputPath, run, inputOptions = []) {
    if (Date.now() >= state.expiresAt || job.url !== state.url) throw new Error('Storyboard job expired or source changed');
    if (state.next < state.plan.count) {
        if (state.activeMs >= 75 * 60_000) throw new Error('Storyboard active extraction budget exceeded');
        const before = state.next;
        const started = Date.now();
        const result = await run(batchArgs(state, job.url, inputOptions), 90_000, true);
        state.activeMs = (state.activeMs || 0) + Date.now() - started;
        await collectCompleted(state);
        if (result.preempted) return { requeue: true, preempted: true };
        if (!result.ok && state.next === before) {
            if (++state.failures >= 3) throw new Error('Storyboard batch failed repeatedly');
            return { requeue: true };
        }
        if (state.next === before) throw new Error('Storyboard source ended before expected coverage');
        state.failures = 0;
        // Release the provider lock and repeat admission before ANY next batch
        // or local assembly (which also consumes CPU on this gateway).
        return { requeue: true };
    }
    const assembled = await run(assemblyArgs(state, outputPath), 30_000, false);
    if (assembled.preempted) return { requeue: true, preempted: true };
    if (!assembled.ok) throw new Error('Storyboard assembly failed');
    return { ok: true, ...state.plan };
}

module.exports = { storyboardPlan, createProgress, disposeProgress, batchArgs, assemblyArgs, collectCompleted, runProgressBatch };
