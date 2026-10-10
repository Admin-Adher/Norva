const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { desktopApplicationUrl, desktopNavigationTarget, wireDesktopNavigation } = require('../desktop/navigation');
const home = 'https://norva.tv/app#home';
const account = 'https://norva.tv/account.html?returnTo=%2Fapp%23home';

function harness() {
    const contents = new EventEmitter(), loaded = [], external = [];
    contents.isDestroyed = () => false;
    contents.loadURL = async url => { loaded.push(url); };
    contents.setWindowOpenHandler = handler => { contents.open = handler; };
    wireDesktopNavigation(contents, { application: home,
        isAuthNavigation: url => new URL(url).hostname === 'accounts.google.com',
        openExternal: url => external.push(url) });
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    return { contents, loaded, external, event };
}

test('clean desktop install opens the cloud catalogue without a local administrator account', () => {
    for (const value of [undefined, '', 'invalid', 'file:///app', 'https://user:password@norva.tv/app']) {
        assert.equal(desktopApplicationUrl(value), home);
    }
    assert.equal(desktopApplicationUrl('http://127.0.0.1:3002/app'), 'http://127.0.0.1:3002/app');
    assert.equal(desktopNavigationTarget('http://127.0.0.1:3002/login.html', 'http://127.0.0.1:3002/app'), null);
});

test('desktop corrects landing and legacy-login entry points without changing the origin', () => {
    for (const route of ['/', '/index.html', '/login.html?returnTo=%2F']) {
        assert.equal(desktopApplicationUrl('https://norva.tv' + route), account);
        assert.equal(desktopNavigationTarget('https://norva.tv' + route, home), account);
    }
    assert.equal(desktopNavigationTarget('https://norva.tv.evil.example/', home), null);
    assert.equal(desktopNavigationTarget('http://norva.tv/', home), null);
});

test('account returns to Home rather than a landing, itself, or an unsafe target', () => {
    for (const value of ['', '/', '/index.html', '/login.html', '/account.html', '//evil.example', '/\\evil.example', 'https://evil.example']) {
        const url = new URL('https://norva.tv/account.html');
        if (value) url.searchParams.set('returnTo', value);
        const fixed = new URL(desktopNavigationTarget(url.href, home));
        assert.equal(fixed.searchParams.get('returnTo'), '/app#home');
    }
    assert.equal(desktopNavigationTarget(account, home), null);
});

test('desktop retains intentional app, subscription and pairing destinations', () => {
    for (const value of ['/app#series', '/app.html#movies', '/subscribe.html', '/cloud.html?pair=ABC234']) {
        const url = new URL('https://norva.tv/account.html');
        url.searchParams.set('returnTo', value);
        assert.equal(desktopNavigationTarget(url.href, home), null);
    }
});

test('OTP, recovery, account-management and OAuth callbacks keep their parameters', () => {
    const url = 'https://norva.tv/account.html?mode=recovery&manage=1&token_hash=synthetic-only&type=recovery#access_token=synthetic-only';
    const fixed = new URL(desktopNavigationTarget(url, home));
    assert.equal(fixed.searchParams.get('mode'), 'recovery');
    assert.equal(fixed.searchParams.get('manage'), '1');
    assert.equal(fixed.searchParams.get('token_hash'), 'synthetic-only');
    assert.equal(fixed.searchParams.get('type'), 'recovery');
    assert.equal(fixed.hash, '#access_token=synthetic-only');
    assert.equal(fixed.searchParams.get('returnTo'), '/app#home');
});

test('the shipped hosted gate sends a clean desktop profile directly to account before landing navigation', async () => {
    const html = fs.readFileSync(require.resolve('../public/app.html'), 'utf8');
    const gate = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
        .find(script => script.includes('norva-post-login-return'));
    const h = harness();
    let redirected;
    const location = { hostname: 'norva.tv', pathname: '/app', search: '', hash: '#home',
        replace(value) {
            redirected = h.event();
            h.contents.emit('will-navigate', redirected, new URL(value, home).href);
        } };
    const storage = { getItem: () => null, setItem() {} };
    vm.runInNewContext(gate, { window: { location }, navigator: { userAgent: 'Electron desktop' },
        localStorage: storage, sessionStorage: storage, console: { log() {}, info() {}, debug() {} } });
    await Promise.resolve();
    assert.equal(redirected.prevented, true);
    assert.deepEqual(h.loaded, [account]);
    assert.deepEqual(h.external, []);
    // The account's successful return is retained without a navigation loop.
    const signedIn = h.event();
    h.contents.emit('will-navigate', signedIn, home);
    assert.equal(signedIn.prevented, false);
});

test('a hydrated expired cloud session reaches Home without reauthentication', async () => {
    const html = fs.readFileSync(require.resolve('../public/app.html'), 'utf8');
    const gate = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
        .find(script => script.includes('norva-post-login-return'));
    const redirects = [];
    const location = { hostname: 'norva.tv', pathname: '/app', search: '', hash: '#home', replace: value => redirects.push(value) };
    vm.runInNewContext(gate, { window: { location }, navigator: { userAgent: 'Electron desktop' },
        localStorage: { getItem: key => key === 'norva-cloud-session' ? JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture', user: { id: 'fixture' }, expires_at: 1 }) : null },
        sessionStorage: { setItem() {} }, console: { log() {}, info() {}, debug() {} } });
    assert.deepEqual(redirects, []);
});

test('redirects and account popups stay in the main window; external destinations retain their boundary', async () => {
    const h = harness();
    const event = h.event();
    h.contents.emit('will-redirect', event, 'https://norva.tv/');
    assert.equal(event.prevented, true);
    assert.deepEqual(h.contents.open({ url: 'https://norva.tv/login.html' }), { action: 'deny' });
    assert.deepEqual(h.contents.open({ url: 'https://accounts.google.com/authorize' }), { action: 'allow' });
    assert.deepEqual(h.contents.open({ url: 'https://norva.tv.evil.example/' }), { action: 'deny' });
    await Promise.resolve();
    assert.deepEqual(h.loaded, [account, account]);
    assert.deepEqual(h.external, ['https://norva.tv.evil.example/']);
    const frame = h.event();
    h.contents.emit('will-redirect', frame, 'https://norva.tv/', false, false);
    assert.equal(frame.prevented, false);
});

test('a closing window does not receive a delayed login redirect', async () => {
    const h = harness();
    h.contents.emit('will-navigate', h.event(), 'https://norva.tv/');
    h.contents.isDestroyed = () => true;
    await Promise.resolve();
    assert.deepEqual(h.loaded, []);
});

test('desktop startup binds the transport to the exact address used by its availability probe', async () => {
    const source = fs.readFileSync(require.resolve('../electron-main.js'), 'utf8');
    let ready, listenHost;
    const env = {}, opened = [];
    const app = { setName() {}, getPath: () => '/fixture', requestSingleInstanceLock: () => true,
        on() {}, whenReady: () => ({ then(callback) { ready = callback; return { catch() {} }; } }) };
    const net = { createServer() { return { unref() {}, on() {},
        listen(_port, host, callback) { listenHost = host; callback(); }, close(callback) { callback(); } }; } };
    class Window { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {} }; }
        on() {} loadURL(url) { opened.push(url); } }
    const imports = { electron: { app, BrowserWindow: Window, BaseWindow: Window, shell: {} },
        fs: { existsSync: () => false }, net, http: { get(_url, callback) {
            callback({ resume() {} }); return { on() {}, setTimeout() {} };
        } }, './desktop/navigation': require('../desktop/navigation') };
    const context = { require(name) {
        if (name === './server/index') { assert.equal(env.NORVA_SERVER_HOST, listenHost); return {}; }
        return imports[name] || require(name);
    }, __dirname: __dirname, process: { env, platform: 'win32' }, console, setTimeout, URL };
    vm.runInNewContext(source, context);
    await ready();
    assert.equal(listenHost, '127.0.0.1');
    assert.equal(env.NORVA_SERVER_HOST, '127.0.0.1');
    assert.deepEqual(opened, [home]);
});
