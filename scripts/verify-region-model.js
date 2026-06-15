const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLIENTS = [
    'public/js/cloudApi.js',
    'clients/mobile-pwa/cloudApi.js'
];

function createStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        },
        removeItem(key) {
            values.delete(key);
        },
        snapshot() {
            return Object.fromEntries(values.entries());
        }
    };
}

function loadClient(relativeFile, seed = {}, locale = 'fr-FR') {
    const localStorage = createStorage(seed);
    const window = {};
    const context = {
        window,
        localStorage,
        navigator: {
            language: locale,
            languages: [locale]
        },
        document: {
            readyState: 'loading',
            body: null,
            addEventListener() {},
            getElementById() { return null; }
        },
        console,
        setTimeout() {}
    };
    vm.createContext(context);
    const source = fs.readFileSync(path.join(ROOT, relativeFile), 'utf8');
    vm.runInContext(source, context, { filename: relativeFile });
    return { NorvaCloud: window.NorvaCloud, localStorage };
}

function assertRegionModel(relativeFile) {
    {
        const { NorvaCloud, localStorage } = loadClient(relativeFile);
        const resolved = NorvaCloud.regions.resolve();
        assert.strictEqual(resolved.region, 'FR', `${relativeFile}: fr-FR should infer FR`);
        assert.strictEqual(resolved.status, 'inferred', `${relativeFile}: locale should remain inferred`);
        assert.strictEqual(localStorage.getItem('norva-preferred-content-region'), null, `${relativeFile}: locale must not persist preference`);
    }

    {
        const { NorvaCloud, localStorage } = loadClient(relativeFile, { 'norva-country': 'US' }, 'fr-FR');
        const resolved = NorvaCloud.regions.resolve();
        assert.strictEqual(resolved.region, 'US', `${relativeFile}: legacy country should remain active`);
        assert.strictEqual(resolved.status, 'inferred', `${relativeFile}: legacy country must not be confirmed`);
        assert.strictEqual(resolved.source, 'legacy', `${relativeFile}: legacy country should be traceable`);
        assert.strictEqual(localStorage.getItem('norva-preferred-content-region'), null, `${relativeFile}: legacy must not migrate into preferred key`);

        NorvaCloud.regions.dismissPrompt();
        const afterDismiss = NorvaCloud.regions.resolve();
        assert.strictEqual(afterDismiss.region, 'US', `${relativeFile}: dismiss should keep active inferred legacy region`);
        assert.strictEqual(afterDismiss.status, 'inferred', `${relativeFile}: dismiss must not confirm legacy region`);
        assert.strictEqual(localStorage.getItem('norva-preferred-content-region'), null, `${relativeFile}: dismiss must not persist preference`);
    }

    {
        const { NorvaCloud, localStorage } = loadClient(relativeFile);
        return Promise.resolve(NorvaCloud.regions.setPreferred('IN', { saveProfile: false })).then((resolved) => {
            assert.strictEqual(resolved.region, 'IN', `${relativeFile}: explicit choice should resolve to IN`);
            assert.strictEqual(resolved.status, 'confirmed', `${relativeFile}: explicit choice should be confirmed`);
            assert.strictEqual(localStorage.getItem('norva-preferred-content-region'), 'IN', `${relativeFile}: explicit choice should persist preferred key`);
            assert.strictEqual(localStorage.getItem('norva-country'), 'IN', `${relativeFile}: explicit choice should keep legacy compatibility key`);
        });
    }
}

(async () => {
    for (const relativeFile of CLIENTS) {
        await assertRegionModel(relativeFile);
    }
    console.log('REGION_MODEL_OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
