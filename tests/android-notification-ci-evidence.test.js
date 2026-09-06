'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/android-notification-proof.yml'), 'utf8');
const verificationStep = workflow.split('      - name: Verify complete evidence outside the emulator shell\n')[1];
assert(verificationStep, 'independent evidence step is required');
const verifier = verificationStep.split("          node <<'NODE'\n")[1].split('\n          NODE')[0]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');

function syntheticEvidence() {
    // Validator fixture only. This is not a real Android rendering proof.
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(72, 16);
    png.writeUInt32BE(72, 20);
    const files = new Map(Object.entries({
        'android-api.txt': '35\n',
        'instrumentation.txt': 'tv.norva.phone.NotificationBrandingInstrumentedTest:...\nOK (3 tests)\n',
        'notification-status-mark-proof.png': png,
        'status-icon-sha256.txt': crypto.createHash('sha256').update(png).digest('hex') + '  proof.png\n',
        'app-package.txt': "package: name='tv.norva.phone' versionCode='32'\n",
        'test-package.txt': "package: name='tv.norva.phone.test' versionCode='0'\n",
        'apk-sha256.txt': 'a'.repeat(64) + '  app.apk\n' + 'b'.repeat(64) + '  test.apk\n',
    }));
    for (const phase of ['before', 'after']) {
        files.set('host-links-' + phase + '.json', '[{"ifname":"lo"}]');
        for (const version of ['ipv4', 'ipv6']) files.set('host-default-' + version + '-' + phase + '.txt', '');
    }
    return files;
}

function verify(files) {
    const writes = new Map();
    const fakeFs = {
        readFileSync(file, encoding) {
            const name = file.replace(/^proof\//, '');
            if (!files.has(name)) throw new Error('ENOENT: ' + name);
            const value = Buffer.from(files.get(name));
            return encoding ? value.toString(encoding) : value;
        },
        writeFileSync(file, value) { writes.set(file, value); },
    };
    vm.runInNewContext(verifier, {
        require(name) {
            if (name === 'node:fs') return fakeFs;
            if (name === 'node:assert/strict') return assert;
            if (name === 'node:crypto') return crypto;
            throw new Error('Unexpected module: ' + name);
        },
        console: { log() {} },
    }, { timeout: 1000 });
    return JSON.parse(writes.get('proof/complete.json'));
}

test('resource CI is manual, network-isolated and protects the complete script from adb stdin', () => {
    assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n\s*(schedule|push|pull_request):|secrets\./);
    assert.match(workflow, /unshare --net/);
    assert.match(workflow, /run_offline_android <\/dev\/null/);
    assert.match(workflow, /-e class tv\.norva\.phone\.NotificationBrandingInstrumentedTest/);
});

test('complete synthetic evidence records only resource validation, not push receipt or Play release', () => {
    const result = verify(syntheticEvidence());
    assert.equal(result.resource_tests, 3);
    assert.equal(result.host_network_isolated_before_and_after, true);
    assert.equal(result.actual_push_receipt_proven, false);
    assert.equal(result.play_release_proven, false);
});

test('missing execution evidence cannot become a green result', () => {
    const files = syntheticEvidence();
    files.delete('instrumentation.txt');
    assert.throws(() => verify(files), /ENOENT/);
});

test('missing or broken post-execution network proof fails closed', () => {
    const missing = syntheticEvidence();
    missing.delete('host-default-ipv6-after.txt');
    assert.throws(() => verify(missing), /ENOENT/);
    const external = syntheticEvidence();
    external.set('host-links-after.json', '[{"ifname":"lo"},{"ifname":"eth0"}]');
    assert.throws(() => verify(external));
});

test('wrong render hash or incomplete test count is refused', () => {
    const wrongHash = syntheticEvidence();
    wrongHash.set('status-icon-sha256.txt', '0'.repeat(64));
    assert.throws(() => verify(wrongHash));
    const incomplete = syntheticEvidence();
    incomplete.set('instrumentation.txt', 'tv.norva.phone.NotificationBrandingInstrumentedTest:.\nOK (1 test)\n');
    assert.throws(() => verify(incomplete));
});
