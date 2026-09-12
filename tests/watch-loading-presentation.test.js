const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/pages/WatchPage.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');

function events() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(key, fn) { listeners.set(key, fn); },
        removeEventListener(key) { listeners.delete(key); },
        dispatch(key) { listeners.get(key)?.(); },
    };
}
function fixture() {
    const document = { ...events(), hidden: false };
    function element() {
        const attrs = new Map(), classes = new Set();
        return {
            children: [], inert: false, isConnected: true, dataset: {}, style: {},
            classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
            getAttribute: k => attrs.get(k) ?? null,
            setAttribute: (k, v) => attrs.set(k, String(v)),
            removeAttribute: k => attrs.delete(k),
            set src(v) { attrs.set('src', v); },
            get src() { return attrs.get('src'); },
            focus() { document.activeElement = this; },
            contains(el) { return el === this || this.children.some(child => child.contains(el)); },
        };
    }
    const section = element(), overlay = element(), loader = element(), video = element();
    const top = element(), back = element(), title = element(), controls = element(), play = element();
    const still = element(), animation = element(), art = element(), label = element(), help = element(), extras = element();
    const motion = { ...events(), matches: false };
    const connection = { ...events(), saveData: false };
    const window = { ...events(), matchMedia: () => motion };
    const navigator = { connection, onLine: true };
    const watch = element(); watch.classList.add('active');
    document.getElementById = id => id === 'page-watch' ? watch : null;
    section.children = [video, loader, overlay, extras];
    overlay.children = [top, controls]; top.children = [back, title]; controls.children = [play];
    overlay.querySelector = () => top;
    loader.closest = () => section;
    loader.querySelector = selector => ({ '.watch-loading-still': still, '.watch-loading-animation': animation, '.watch-loading-art': art, '.watch-loading-label': label, '.watch-loading-help': help })[selector];
    still.dataset.src = '/img/watch/norva-loading-still.webp';
    animation.dataset.src = '/img/watch/norva-loading-60fps.webp';
    label.dataset.i18n = 'ui_watch_preparing_video';
    help.dataset.i18n = 'ui_watch_preparing_video_help';
    const context = { window, document, navigator, console, setTimeout, clearTimeout };
    vm.runInNewContext(source, context);
    const page = Object.create(window.WatchPage.prototype);
    Object.assign(page, { loadingSpinner: loader, overlay, video, backBtn: back, centerPlayBtn: play });
    document.activeElement = play;
    return { page, section, overlay, loader, video, back, title, controls, play, extras, still, animation, art, label, help, document, window, navigator, motion, connection };
}

test('preparation masks transport UI, retains Back and does not hide or pause video', () => {
    const f = fixture();
    f.page.showLoading();
    assert.equal(f.section.classList.contains('has-playback-loading'), true);
    for (const el of [f.title, f.controls, f.extras]) {
        assert.equal(el.inert, true);
        assert.equal(el.getAttribute('aria-hidden'), 'true');
    }
    assert.equal(f.back.inert, false);
    assert.equal(f.document.activeElement, f.back);
    assert.equal(f.video.inert, false);
    assert.equal(f.video.getAttribute('aria-hidden'), 'true');
    assert.deepEqual(f.video.style, {});
    assert.equal(f.loader.getAttribute('aria-hidden'), 'false');
    assert.equal(f.still.src, f.still.dataset.src);
    assert.equal(f.animation.src, f.animation.dataset.src);
    assert.equal(f.art.classList.contains('is-animated'), false, 'poster remains until animation is loaded');
    f.animation.onload();
    assert.equal(f.art.classList.contains('is-animated'), true);
});

test('repeat waiting is idempotent; ready restores prior aria/inert state and focus', () => {
    const f = fixture();
    f.extras.inert = true; f.extras.setAttribute('aria-hidden', 'true');
    f.page.showLoading(); f.page.showLoading(); f.page.hideLoading();
    assert.equal(f.controls.inert, false);
    assert.equal(f.controls.getAttribute('aria-hidden'), null);
    assert.equal(f.video.getAttribute('aria-hidden'), null);
    assert.equal(f.extras.inert, true);
    assert.equal(f.extras.getAttribute('aria-hidden'), 'true');
    assert.equal(f.document.activeElement, f.play);
    assert.equal(f.loader.getAttribute('aria-hidden'), 'true');
    assert.equal(f.section.classList.contains('has-playback-loading'), false);
    assert.equal(f.animation.getAttribute('src'), null);
    assert.equal(f.art.classList.contains('is-animated'), false);
    for (const emitter of [f.document, f.window, f.motion, f.connection]) assert.equal(emitter.listeners.size, 0);
    clearTimeout(f.page.overlayTimeout);
});

test('reduced motion, data saving and hidden tabs stop the animation and react to changes', () => {
    for (const mode of ['motion', 'data', 'hidden']) {
        const f = fixture();
        if (mode === 'motion') f.motion.matches = true;
        if (mode === 'data') f.connection.saveData = true;
        if (mode === 'hidden') f.document.hidden = true;
        f.page.showLoading();
        assert.equal(f.animation.getAttribute('src'), null);
        f.motion.matches = false; f.connection.saveData = false; f.document.hidden = false;
        f.document.dispatch('visibilitychange');
        assert.equal(f.animation.src, f.animation.dataset.src);
        f.motion.matches = true; f.motion.dispatch('change');
        assert.equal(f.animation.getAttribute('src'), null);
        f.page.hideLoading({ restoreFocus: false });
    }
});

test('artwork failure never gates playback, never loops requests and keeps the fallback', () => {
    const f = fixture(); f.page.showLoading(); f.animation.onerror();
    assert.equal(f.page._loadingArtworkFailed, true);
    assert.equal(f.animation.getAttribute('src'), null);
    assert.equal(f.still.src, f.still.dataset.src);
    f.page.refreshLoadingArtwork();
    assert.equal(f.animation.getAttribute('src'), null);
    f.still.onerror();
    assert.equal(f.still.style.visibility, 'hidden');
    assert.equal(f.loader.getAttribute('aria-hidden'), 'false', 'status remains readable without any artwork');
    f.page.hideLoading({ restoreFocus: false });
});

test('offline status is localized separately from terminal playback recovery', () => {
    const f = fixture(); f.page.showLoading();
    f.navigator.onLine = false; f.window.dispatch('offline');
    assert.equal(f.label.dataset.i18n, 'ui_web_4d5c943931a4');
    assert.equal(f.label.textContent, 'You are offline');
    assert.equal(f.help.dataset.i18n, 'ui_watch_preparing_video_offline');
    assert.equal(f.help.textContent, 'Check your internet connection to continue preparing your video.');
    f.navigator.onLine = true; f.window.dispatch('online');
    assert.equal(f.label.dataset.i18n, 'ui_watch_preparing_video');
    assert.equal(f.label.textContent, 'Preparing your video');
    assert.equal(f.help.dataset.i18n, 'ui_watch_preparing_video_help');
    assert.equal(f.help.textContent, 'Playback will start automatically when your video is ready.');
    f.page.hideLoading({ restoreFocus: false });
});

test('transport shortcuts/clicks are blocked, but Back, Tab and OS shortcuts remain usable', () => {
    const f = fixture(); f.page.showLoading();
    let skipped = 0, back = 0;
    f.page.skip = () => skipped++;
    f.page.goBack = () => back++;
    for (const key of [' ', 'k', 'j', 'ArrowRight', '9', 'n', 'c']) {
        let prevented = false;
        f.page.handleKeyboard({ key, target: { tagName: 'BODY' }, preventDefault() { prevented = true; } });
        assert.equal(prevented, true, key);
    }
    for (const event of [{ key: 'Tab' }, { key: 'r', ctrlKey: true }, { key: ' ', target: f.back }, { key: 'j', target: { tagName: 'INPUT' } }]) {
        f.page.handleKeyboard({ target: { tagName: 'BODY' }, preventDefault() { assert.fail('native key was blocked'); }, ...event });
    }
    f.page.togglePlay(); // Fake video has no pause/play: any transport call would fail.
    f.page.handleKeyboard({ key: 'Escape', target: { tagName: 'BODY' } });
    assert.equal(skipped, 0); assert.equal(back, 1);
    f.page.hideLoading({ restoreFocus: false });
});

test('error/autoplay/teardown keep their escape paths; internal session handoff keeps the cover', () => {
    assert.match(source, /if \(!preservePlaybackResolutionAttempt\) this\.hideLoading\(\{ restoreFocus: false \}\)/);
    for (const method of ['handleAutoplayError', 'showPlaybackError']) {
        const body = source.slice(source.indexOf(`    ${method}(`)).split(/\n    [a-zA-Z]+\(/)[0];
        assert.match(body, /this\.hideLoading\(/, method);
    }
    const f = fixture(); f.page.showLoading(); f.page.hideLoading({ restoreFocus: false });
    assert.equal(f.document.activeElement, f.back, 'exit must not focus a hidden player control');
});

test('first-frame gate owns reveal, with no artificial animation timer', () => {
    const f = fixture(); f.page.showLoading();
    f.page.hasCurrentMedia = () => true;
    f.page._firstFrameReported = false;
    f.page.markPlaybackUsable();
    assert.equal(f.page._loadingPresentationActive, true);
    f.page._firstFrameReported = true;
    f.page.hidePlaybackError = () => {};
    f.page._playbackStatusOkReported = true;
    f.page.reportObservedAudioLanguages = () => {};
    f.page.markPlaybackUsable();
    assert.equal(f.page._loadingPresentationActive, false);
    clearTimeout(f.page.overlayTimeout);
});

test('asset/layout contracts: VOD only, lazy artwork, accessible status, no video visibility trick', () => {
    const loader = html.indexOf('id="watch-loading"');
    assert.ok(loader < html.indexOf('id="watch-overlay"'));
    assert.equal((html.match(/id="watch-loading"/g) || []).length, 1);
    assert.match(html, /id="player-loading">\s*<div class="loading-spinner"/);
    assert.match(html, /class="watch-loading-status" role="status" aria-live="polite" aria-atomic="true">\s*<p class="watch-loading-label"[^>]+>[^<]+<\/p>\s*<p class="watch-loading-help"/);
    assert.match(html, /data-src="\/img\/watch\/norva-loading-60fps\.webp"/);
    assert.doesNotMatch(html, /\ssrc="\/img\/watch\/norva-loading-60fps\.webp"/);
    const start = css.indexOf('/* VOD preparation only;');
    const block = css.slice(start, css.indexOf('@keyframes spin', start));
    assert.doesNotMatch(block, /#watch-video\s*\{|filter:|backdrop-filter:|animation:/);
    assert.match(block, /background: var\(--color-bg-primary\)/);
    assert.match(block, /prefers-reduced-motion: reduce/);
    assert.match(block, /min-height: 48px/);
    for (const [file, limit] of [['norva-loading-60fps.webp', 1024 * 1024], ['norva-loading-still.webp', 25 * 1024]]) {
        assert.ok(fs.statSync(path.join(root, 'public/img/watch', file)).size < limit, file);
    }
    const webp = fs.readFileSync(path.join(root, 'public/img/watch/norva-loading-60fps.webp'));
    assert.equal(webp.toString('ascii', 0, 4), 'RIFF');
    assert.equal(webp.toString('ascii', 8, 12), 'WEBP');
    const durations = []; let loop;
    for (let offset = 12; offset + 8 <= webp.length;) {
        const kind = webp.toString('ascii', offset, offset + 4), length = webp.readUInt32LE(offset + 4);
        if (kind === 'ANIM') loop = webp.readUInt16LE(offset + 12);
        if (kind === 'ANMF') durations.push(webp.readUIntLE(offset + 20, 3));
        offset += 8 + length + (length % 2);
    }
    assert.equal(loop, 0);
    assert.equal(durations.length, 216);
    assert.equal(durations.reduce((a, b) => a + b, 0), 3600);
    assert.ok(durations.every(ms => ms === 16 || ms === 17));
});

test('preparation copy identifies the video in every locale without changing generic preparation text', () => {
    const catalog = require('../scripts/i18n/catalog.cjs').load();
    const locales = require('../i18n/locales.json');
    for (const key of ['ui_watch_preparing_video', 'ui_watch_preparing_video_help', 'ui_watch_preparing_video_offline']) {
        for (const { code } of locales) assert.ok(catalog[key][code]?.trim(), `${key}: ${code}`);
    }
    assert.equal(catalog.ui_watch_preparing_video.fr, 'Préparation de votre vidéo');
    assert.equal(catalog.ui_web_5d1fa38bcf0d.fr, 'Préparation…');
    const f = fixture(); f.page.showLoading();
    let writes = 0;
    for (const el of [f.label, f.help]) Object.defineProperty(el, 'textContent', { set() { writes++; } });
    f.page.refreshLoadingArtwork();
    assert.equal(writes, 0, 'artwork/visibility refresh must not repeat live-region announcements');
    f.page.hideLoading({ restoreFocus: false });
});
