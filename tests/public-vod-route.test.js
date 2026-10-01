const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicVodDirectRoute, isPublicDirectRoute } = require('../services/media-gateway/src/public-vod-route');
const base = 'https://objectstorage.us-phoenix-1.oraclecloud.com/n/axa4wow3dcia/b/bucket-20201001-1658/o/';
test('qualified public MP4 selects a direct route', () => {
    const route = publicVodDirectRoute(base + 'folder%2Ffilm.mp4');
    assert.equal(isPublicDirectRoute(route), true);
    assert.equal(route.slot, 0);
});
test('credentials, signatures and arbitrary buckets stay on the provider route', () => {
    for (const url of [
        base.replace('https:', 'http:') + 'film.mp4',
        base.replace('https://', 'https://user:pass@') + 'film.mp4',
        base.replace('bucket-20201001-1658', 'private') + 'film.mp4',
        base.replace('oraclecloud.com', 'oraclecloud.com.evil.test') + 'film.mp4',
        base + 'film.mp4?token=private', base + 'film.mp4#private',
        base + 'film.mkv', base + '../private/film.mp4', 'not-a-url',
    ]) assert.equal(publicVodDirectRoute(url), null, url);
});
test('direct route cannot be inferred from a zero slot alone', () => {
    assert.equal(isPublicDirectRoute({ nodeTransport:'direct', slot:0 }), false);
    assert.equal(isPublicDirectRoute(null), false);
});
test('the actual FFmpeg environment removes proxy variables only for the qualified route', () => {
    const source = require('node:fs').readFileSync('services/media-gateway/src/index.js','utf8');
    const code = source.slice(source.indexOf('function proxyEnvFor('), source.indexOf('function redactStrictLidLoopback('));
    const context = { isPublicDirectRoute, process:{env:{https_proxy:'old',ALL_PROXY:'old',KEEP:'value'}},
        providerHttpProxyUrls:['configured-proxy'],poolIndexForKey:()=>0 };
    require('node:vm').runInNewContext(code,context);
    const direct = context.proxyEnvFor('public',publicVodDirectRoute(base+'film.mp4'));
    assert.equal(direct.https_proxy,undefined); assert.equal(direct.ALL_PROXY,undefined); assert.equal(direct.KEEP,'value');
    assert.equal(context.proxyEnvFor('ordinary').https_proxy,'configured-proxy');
});
