'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createEnrichmentPilotAdmission } = require('../services/media-gateway/src/enrichment-pilot-admission');
const { createEnrichmentNetworkAdmission } = require('../services/media-gateway/src/enrichment-network-admission');
const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
const functions = source.slice(source.indexOf('function claimLanguageEnrichmentNetwork('), source.indexOf("app.post('/probe-audio'"));
const selected = 'a'.repeat(64), other = 'b'.repeat(64);
const url = account => `https://provider.invalid/movie/${account}/test/file.mkv`;
const key = value => new URL(value).pathname.split('/')[2];

function fixture(mode = 'pilot') {
    let now = 100000;
    const pilot = createEnrichmentPilotAdmission(mode === 'pilot' ? {
        protocol: 1, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(), fileKeys: [selected],
    } : undefined, { mode, now: () => now });
    const admission = createEnrichmentNetworkAdmission();
    const activity = { viewer: false, probeCalls: 0 };
    const extractions = new Map();
    const context = vm.createContext({ URL, enrichmentPilot: pilot,
        enrichmentNetworkAdmission: admission, proxyKeyFromUrl: key,
        LANGUAGE_HOST_ADAPTIVE_ADMISSION_ENABLED: false,
        selectionEnrichmentPolicy: { configured: false },
        createProviderProbeDrainState: () => ({}), isHttpUrl: () => true,
        sanitizeUserAgent: value => value,
        accountSlotBusyLocally: () => activity.viewer, accountExtractions: extractions,
        probeCodecProfile: () => { activity.probeCalls++; throw new Error('unexpected provider read'); },
    });
    vm.runInContext(functions, context);
    return { context, admission, activity, extractions, expire: () => { now += 60001; } };
}

test('a pilot preserves legacy admission for unrelated files even when its new lane is full', () => {
    const f = fixture();
    const first = f.context.claimOptionalLanguageEnrichmentNetwork(url('one'), null, false, selected);
    const second = f.context.claimOptionalLanguageEnrichmentNetwork(url('two'), null, false, selected);
    assert.equal(f.admission.snapshot().active, 2);
    assert.equal(f.context.claimOptionalLanguageEnrichmentNetwork(url('three'), null, false, other), null);
    assert.equal(f.context.claimOptionalLanguageEnrichmentNetwork(url('four')), null);
    assert.equal(f.admission.snapshot().active, 2);
    assert.throws(() => f.context.claimOptionalLanguageEnrichmentNetwork(url('three'), null, false, selected),
        { code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY' });
    assert.throws(() => f.context.claimLanguageEnrichmentNetwork(url('three'), null, false, other),
        { code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY' });
    first.release({ providerDrained: true }); second.release({ providerDrained: true });
    assert.equal(f.admission.snapshot().active, 0);
});

test('expiry restores legacy probes but never grants an expired explicit capture', () => {
    const f = fixture(); f.expire();
    assert.equal(f.context.claimOptionalLanguageEnrichmentNetwork(url('one'), null, false, selected), null);
    assert.throws(() => f.context.claimLanguageEnrichmentNetwork(url('one'), null, false, selected),
        { code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY' });
    assert.equal(f.admission.snapshot().active, 0);
});

test('fleet mode retains the shared network limits for every file', () => {
    const f = fixture('fleet');
    const lease = f.context.claimOptionalLanguageEnrichmentNetwork(url('one'), null, false, other);
    assert.equal(f.admission.snapshot().active, 1);
    assert.throws(() => f.context.claimOptionalLanguageEnrichmentNetwork(url('one'), null, false, selected),
        { code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY' });
    lease.release({ providerDrained: true });
});

for (const guard of ['viewer', 'extraction']) test(`an unrelated legacy probe still yields to an active ${guard}`, async () => {
    const f = fixture();
    if (guard === 'viewer') f.activity.viewer = true;
    else f.extractions.set('one', new Set(['existing-reader']));
    let status, response;
    const res = { status(value) { status = value; return this; }, json(value) { response = value; return this; } };
    await f.context.handleProbeAudioRequest({ body: { url: url('one'), enrichmentFileKey: other } }, res,
        { claimNetwork: f.context.claimOptionalLanguageEnrichmentNetwork });
    assert.equal(status, guard === 'viewer' ? 409 : 429);
    assert.equal(response.code, guard === 'viewer' ? 'account_busy' : 'background_busy');
    assert.equal(f.activity.probeCalls, 0);
    assert.equal(f.admission.snapshot().active, 0);
});
