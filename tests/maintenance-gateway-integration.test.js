'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const acorn = require('acorn');
const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const functions = ['storyboardMaintenanceRecord', 'gatewayMaintenanceSnapshot'].map(name => {
    const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    assert.ok(node, name); return source.slice(node.start, node.end);
}).join('\n');
function context() {
    const c = { crypto, languageForegroundWorkSnapshot: () => ({ activeOperations: 0, admissionChecks: 0 }),
        whisperInferenceActive: 0, argosInferenceActive: 0, lidLanguageWavActive: 0, lidBenchmarkBusy: false,
        providerRouteBenchmarkPublicStatus: () => ({ active: false }), activeSessionCount: () => 0,
        viewerPlaybackActiveLocally: () => false, transcribeQueue: [], ocrQueue: [], translateQueue: [] };
    for (const key of ['accountJobLocks', 'backgroundCpuProcesses', 'strictLidBrokers',
        'finiteMkvLinearSeekBridges', 'mkvH264FullFileAnalyzers', 'activeViewerSubtitleOperations',
        'rawPumps', 'viewerStartupReservations', 'viewerSessionStartupAdmissions']) c[key] = new Set();
    vm.createContext(c); vm.runInContext(functions, c); return c;
}
test('Gateway maintenance snapshot includes each active work and viewer reservation', () => {
    const c = context();
    assert.equal(c.gatewayMaintenanceSnapshot().activeOperations, 0);
    for (const key of ['accountJobLocks', 'backgroundCpuProcesses', 'strictLidBrokers',
        'finiteMkvLinearSeekBridges', 'mkvH264FullFileAnalyzers', 'activeViewerSubtitleOperations']) {
        c[key].add('test'); assert.equal(c.gatewayMaintenanceSnapshot().activeOperations, 1, key); c[key].clear();
    }
    for (const key of ['rawPumps', 'viewerStartupReservations', 'viewerSessionStartupAdmissions']) {
        c[key].add('test'); assert.equal(c.gatewayMaintenanceSnapshot().viewerSessions, 1, key); c[key].clear();
    }
    c.languageForegroundWorkSnapshot = () => ({ activeOperations: 1, admissionChecks: 1 });
    assert.equal(c.gatewayMaintenanceSnapshot().activeOperations, 2);
});
test('Gateway compares restored checkpoint progress with the exact in-memory progress', () => {
    const c = context();
    const job = { jobId: 'test', kind: 'storyboard', durable: true, uid: 'test-owner',
        callbackUrl: 'https://example.invalid/callback', duration: 100,
        storyboardProgress: { plan: [0, 10, 20], next: 2, failures: [], sourceBinding: 'test-source', activeMs: 20 } };
    const restored = { ...job, progress: structuredClone(job.storyboardProgress) };
    delete restored.storyboardProgress;
    assert.equal(c.storyboardMaintenanceRecord(job).checkpointDigest, c.storyboardMaintenanceRecord(restored).checkpointDigest);
    restored.progress.next++;
    assert.notEqual(c.storyboardMaintenanceRecord(job).checkpointDigest, c.storyboardMaintenanceRecord(restored).checkpointDigest);
    c.transcribeQueue.push(job);
    const snapshot = c.gatewayMaintenanceSnapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(JSON.stringify(snapshot).includes('test-owner'), false);
    assert.equal(JSON.stringify(snapshot).includes('callback'), false);
});
