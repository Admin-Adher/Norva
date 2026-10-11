'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRecentResumeOwnerGate } = require('../services/media-gateway/src/private-resume-binding');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
function gates(env) {
    const ctx = vm.createContext({ process: { env }, createRecentResumeOwnerGate, PRIVATE_RESUME_CACHE_ENABLED: env.PRIVATE_RESUME_CACHE_ENABLED === 'true' });
    const read = name => {
        const start = source.indexOf(`const ${name} = createRecentResumeOwnerGate(`);
        const code = source.slice(start, source.indexOf('\n});', start) + 4);
        return vm.runInContext(`(()=>{${code};return ${name};})()`, ctx);
    };
    return { startup: read('canUseStartupCache'), retained: read('retainedSessionOwnerGate'), observation: read('startupObservationOwnerGate') };
}
const keys = { startup: 'PRIVATE_STARTUP_CACHE', retained: 'PRIVATE_RETAINED_SESSION', observation: 'VOD_STARTUP_OBSERVATION' };
test('all Gateway rollout gates enroll new owners explicitly and retain independent rollback and invalid-owner rejection', () => {
    const env = { PRIVATE_RESUME_CACHE_ENABLED: 'true' };
    for (const key of Object.values(keys)) Object.assign(env, { [key + '_ENABLED']: 'true', [key + '_OWNER_HASHES']: 'a'.repeat(64) });
    for (const [name, gate] of Object.entries(gates(env))) {
        assert.equal(gate('a'.repeat(64)), true, name);
        assert.equal(gate('b'.repeat(64)), false, name);
    }
    for (const key of Object.values(keys)) env[key + '_ALL_AUTHENTICATED_OWNERS'] = 'true';
    for (const [name, gate] of Object.entries(gates(env))) {
        for (let i = 0; i < 24; i++) assert.equal(gate(i.toString(16).padStart(64, '0')), true, name);
        assert.equal(gate(''), false); assert.equal(gate('invalid'), false);
        const key = keys[name];
        assert.equal(gates({ ...env, [key + '_ENABLED']: 'false' })[name]('b'.repeat(64)), false);
        assert.equal(gates({ ...env, [key + '_ALL_AUTHENTICATED_OWNERS']: 'false' })[name]('b'.repeat(64)), false);
        assert.equal(gates({ ...env, [key + '_ALL_AUTHENTICATED_OWNERS']: 'TRUE', [key + '_OWNER_HASHES']: '' })[name]('b'.repeat(64)), false);
    }
    assert.equal(gates({ ...env, PRIVATE_RESUME_CACHE_ENABLED: 'false' }).startup('b'.repeat(64)), false);
});
