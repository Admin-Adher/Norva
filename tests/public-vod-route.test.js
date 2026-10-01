const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicVodDirectRoute, isPublicDirectRoute } = require('../services/media-gateway/src/public-vod-route');
const base = 'https://objectstorage.us-phoenix-1.oraclecloud.com/n/axa4wow3dcia/b/bucket-20201001-1658/o/';
test('qualified public MP4 selects a direct route', () => {
    const route = publicVodDirectRoute(base + 'folder%2Ffilm.mp4');
    assert.equal(isPublicDirectRoute(route), true);
    assert.equal(route.slot, 0);
});

test('the measured public Sandro movie path is direct, private or unrelated routes are not', () => {
    const host='https://sandroflix.sandrostoreps3.workers.dev';
    assert.ok(isPublicDirectRoute(publicVodDirectRoute(host+'/content/filmes/LANCAMENTOS/Downton.Abbey.A.New.Era.2022.mp4')));
    for (const url of [host+'/movie/user/password/1.mp4',host+'/content/series/1.mp4',
        host+'/content/filmes/../private/1.mp4',host+'/content/filmes/a.mp4?token=x',
        host.replace('.dev','.dev.evil.test')+'/content/filmes/a.mp4',
        host.replace('https://','https://user:password@')+'/content/filmes/a.mp4']) {
        assert.equal(publicVodDirectRoute(url),null);
    }
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

test('range broker receives an owned direct agent instead of its default proxy fallback', () => {
    const source = require('node:fs').readFileSync('services/media-gateway/src/index.js','utf8');
    const code = source.slice(source.indexOf('function pinnedProxyAgentFactoryForRoute('), source.indexOf('function waitForVodInputRetry('));
    let agents = 0;
    const context = { isPublicDirectRoute, Agent: class { constructor() { agents++; this.direct = true; } },
        providerNodeRouteIsAvailable: route => !!route?.slot,
        providerSocksProxyUrls: [], providerHttpProxyUrls: ['proxy'], createProviderProxyAgent: url => ({url}) };
    require('node:vm').runInNewContext(code,context);
    const factory = context.pinnedProxyAgentFactoryForRoute(publicVodDirectRoute(base+'film.mp4'));
    assert.equal(typeof factory, 'function');
    assert.equal(factory().direct, true); assert.equal(factory().direct, true);
    assert.equal(agents, 2, 'broker refresh owns a fresh direct connection pool');
    assert.equal(context.pinnedProxyAgentFactoryForRoute({slot:1,nodeTransport:'http'})().url, 'proxy');
    assert.equal(context.pinnedProxyAgentFactoryForRoute(null), null);
});

test('public probe/capture routing respects an explicit operator route and ordinary account affinity', () => {
    const fs=require('node:fs'),vm=require('node:vm');
    const source=fs.readFileSync('services/media-gateway/src/index.js','utf8');
    const code=source.slice(source.indexOf('function providerNodeRouteForSession('),source.indexOf('function providerProxyAgentForRoute('));
    const overrides=new Set();
    const context={publicVodDirectRoute,isPublicDirectRoute,providerProxySlotOverrides:overrides,
        proxyKeyFromUrl:url=>new URL(url).host,sha256Hex:x=>x,
        providerNodeRouteIsAvailable:r=>r?.slot===1,providerRouteForKey:()=>({slot:1,nodeTransport:'socks5'}),
        useProviderHttpForward:()=>false,providerHttpForwardAccounts:new Set(),providerHttpForwardPolicy:{}};
    vm.runInNewContext(code,context);
    const url='https://sandroflix.sandrostoreps3.workers.dev/content/filmes/a.mp4';
    assert.ok(isPublicDirectRoute(context.providerNodeRouteForSession({sourceUrl:url})));
    overrides.add(new URL(url).host);
    assert.equal(context.providerNodeRouteForSession({sourceUrl:url}).nodeTransport,'socks5');
    assert.equal(context.providerNodeRouteForSession({sourceUrl:'https://private.test/movie/u/p/1.mp4'}).nodeTransport,'socks5');
    assert.match(source,/proxyEnvFor\(proxyKeyFromUrl\(sourceUrl\), providerNodeRouteForSession\(\{ sourceUrl \}\)\)/);
    assert.match(source,/openBroker: [\s\S]*?dispatcherFactory: pinnedProxyAgentFactoryForRoute\(providerNodeRouteForSession\(\{ sourceUrl: context.url \}\)\)/);
});
