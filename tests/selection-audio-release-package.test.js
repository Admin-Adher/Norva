'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { collectSelectionModules, imports, packageSelectionRelease, verifySelectionRelease } =
    require('../ops/hetzner/scripts/package-selection-audio-release-20260911.cjs');
const repository = path.resolve(__dirname, '..');
const modules = collectSelectionModules(repository);
const temporary = t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-selection-package-test-'));
    t.after(() => fs.rmSync(dir, { recursive:true,force:true }));
    return dir;
};

test('real Selection import closure includes the new task pool and preserves the compose bind layouts', t => {
    const root = path.join(temporary(t),'release');
    const receipt = packageSelectionRelease(root,modules);
    assert.equal(receipt.passed,true);assert.equal(receipt.productionWrites,0);assert.equal(receipt.providerRequests,0);
    assert.ok(modules.some(file => file.target === 'runner/selection-audio-task-pool.mjs'));
    assert.ok(modules.some(file => file.target === 'functions/_shared/selection-qualified-vod.mjs'));
    assert.equal(receipt.activation,'not-activated');
    assert.equal(receipt.canary,'requires-runtime-scope-verification');
    assert.deepEqual(verifySelectionRelease(root,modules),receipt);
    assert.throws(() => packageSelectionRelease(root,modules),{code:'SELECTION_PACKAGE_DESTINATION_EXISTS_OR_RELATIVE'});
});

test('missing modules, changed bytes and extra files cannot masquerade as a verified release', t => {
    for (const mode of ['missing','modified','extra']) {
        const root=path.join(temporary(t),'release');packageSelectionRelease(root,modules);
        const target=path.join(root,'runner/selection-audio-task-pool.mjs');
        if (mode === 'missing') fs.unlinkSync(target);
        if (mode === 'modified') fs.appendFileSync(target,'\n// changed\n');
        if (mode === 'extra') fs.writeFileSync(path.join(root,'.env'),'DO_NOT_READ=this_is_not_a_credential');
        assert.throws(() => verifySelectionRelease(root,modules),e => e.code?.startsWith('SELECTION_PACKAGE_'));
    }
});

test('actual packaged worker imports at the real runtime layout without connecting to any service', async t => {
    const dir=temporary(t),release=path.join(dir,'release'),runtime=path.join(dir,'runtime');
    packageSelectionRelease(release,modules);
    for(const file of modules) {
        const target=path.join(runtime,file.source);
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.copyFileSync(path.join(release,file.target),target);
    }
    let requests=0;const originalFetch=globalThis.fetch;
    globalThis.fetch=async()=>{requests++;throw Error('No network allowed in packaging proof');};
    try {
        const worker=await import(pathToFileURL(path.join(runtime,'ops/hetzner/services/selection-audio-worker.mjs')).href);
        assert.equal(typeof worker.runSelectionAudioWorker,'function');
        const gateway=await import(pathToFileURL(path.join(runtime,'supabase/functions/_shared/selection-audio-gateway.mjs')).href);
        const files=await gateway.getSelectionAudioManifest();
        assert.ok(files.length>1000);assert.equal(new Set(files.map(f=>f.externalId)).size,files.length);
        assert.equal(requests,0);
    } finally {globalThis.fetch=originalFetch;}
});

test('static import parsing cannot hide a nonliteral runtime dependency',()=>{
    assert.deepEqual(imports("export {x} from './a.mjs'; import './b.mjs'; import('./a.mjs');"),['./a.mjs','./b.mjs']);
    assert.throws(()=>imports('export const f = x => import(x);'),{code:'SELECTION_PACKAGE_DYNAMIC_IMPORT'});
});
