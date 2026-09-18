'use strict';
// Run ONLY in a disposable --network=none container, without production mounts.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { StoryboardStore } = require('/app/src/storyboard-store');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    const root = '/tmp/maintenance-smoke-storyboards', secret = 'isolated-smoke-not-production';
    const store = new StoryboardStore(root, secret);
    const id = '00000000-0000-4000-8000-000000000001';
    await store.save({ jobId: id, uid: 'fixture', kind: 'storyboard', durable: true,
        callbackUrl: 'https://example.invalid/callback', duration: 100,
        storyboardNotBefore: Date.now() + 3600000,
        storyboardProgress: { plan: { count: 10, intervalSec: 10, cols: 10, rows: 1 },
            next: 0, failures: 0, activeMs: 0, sourceBinding: 'f'.repeat(64) } });
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    for (let boot = 0; boot < 2; boot++) {
        const child = spawn(process.execPath, ['/app/src/index.js'], { env: { ...process.env,
            GATEWAY_TOKEN: secret, GATEWAY_MAINTENANCE_ENABLED: 'true', PORT: '18080',
            STORYBOARD_PRIVATE_DIR: root, STORYBOARD_DURABLE_SOURCE_IDS: 'fixture',
            NORVA_BACKEND_ORIGINS: 'https://example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let logs = '';
        child.stdout.on('data', b => { logs = (logs + b).slice(-4000); });
        child.stderr.on('data', b => { logs = (logs + b).slice(-4000); });
        try {
            let health;
            for (let n = 0; n < 100; n++) {
                if (child.exitCode !== null) throw Error('Candidate exited before readiness: ' + logs);
                try { health = await (await fetch('http://127.0.0.1:18080/health')).json(); break; } catch {}
                await pause(100);
            }
            assert.ok(health, 'candidate became healthy');
            assert.equal(health.storyboardDurability.pending, 1);
            assert.equal(health.transcribeQueueDepth, 1);
            const post = async (action, body = {}) => {
                const r = await fetch('http://127.0.0.1:18080/maintenance/' + action,
                    { method: 'POST', headers, body: JSON.stringify(body) });
                return { status: r.status, body: await r.json() };
            };
            let result = await post('prepare');
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.ready, true);
            const commit = await post('commit', { token: result.body.token });
            assert.equal(commit.status, 200, JSON.stringify(commit.body));
            assert.equal(commit.body.committed, true);
            assert.equal((await store.load()).length, 1);
            console.log(JSON.stringify({ boot: boot + 1, restoredJobs: 1, maintenanceCommitted: true }));
        } finally {
            const exited = new Promise(resolve => child.once('exit', resolve));
            if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
        }
    }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
