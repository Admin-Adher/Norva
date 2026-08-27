'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const settingsSource = fs.readFileSync(path.join(root, 'public/js/pages/Settings.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
        dump() { return Object.fromEntries(values); },
    };
}

function classList(initial = []) {
    const values = new Set(initial);
    return {
        add(...names) { names.forEach((name) => values.add(name)); },
        remove(...names) { names.forEach((name) => values.delete(name)); },
        contains(name) { return values.has(name); },
        toggle(name, force) {
            const enabled = force === undefined ? !values.has(name) : !!force;
            if (enabled) values.add(name);
            else values.delete(name);
            return enabled;
        },
    };
}

function tab(name, { display = '', hidden = false } = {}) {
    const attributes = new Map();
    return {
        dataset: { tab: name },
        classList: classList(name === 'account' ? ['active'] : []),
        style: { display },
        hidden,
        disabled: false,
        tabIndex: name === 'account' ? 0 : -1,
        setAttribute(key, value) { attributes.set(key, String(value)); },
        getAttribute(key) { return attributes.get(key) || null; },
    };
}

function panel(name) {
    const attributes = new Map();
    return {
        id: `tab-${name}`,
        classList: classList(name === 'account' ? ['active'] : []),
        hidden: name !== 'account',
        scrollTop: 0,
        setAttribute(key, value) { attributes.set(key, String(value)); },
        getAttribute(key) { return attributes.get(key) || null; },
    };
}

function loadSettings({ persistedTab = '', cloud = false } = {}) {
    const names = ['account', 'screens', 'player', 'sources', 'content', 'transcode', 'users'];
    const tabs = names.map((name) => tab(name, {
        display: (name === 'screens' || name === 'users') ? 'none' : '',
    }));
    const panels = names.map(panel);
    const byId = new Map([
        ['users-tab', tabs.find((item) => item.dataset.tab === 'users')],
        ['screens-tab', tabs.find((item) => item.dataset.tab === 'screens')],
    ]);
    const location = { hash: '#settings', search: '' };
    const sessionStorage = memoryStorage(persistedTab
        ? { 'norva-settings-tab-v1': persistedTab }
        : {});
    const history = {
        state: { page: 'settings', idx: 4, marker: 'preserved' },
        replacements: [],
        pushes: [],
        replaceState(state, _title, url) {
            this.state = state;
            this.replacements.push({ state, url });
            location.hash = url;
        },
        pushState(state, _title, url) {
            this.pushes.push({ state, url });
        },
    };
    const document = {
        documentElement: { classList: classList() },
        getElementById(id) { return byId.get(id) || null; },
        querySelector() { return null; },
    };
    const window = {
        location,
        matchMedia() { return { matches: false }; },
    };
    const sandbox = {
        console,
        document,
        history,
        navigator: { userAgent: 'Norva browser test' },
        requestAnimationFrame(callback) { callback(); },
        sessionStorage,
        window,
    };
    window.window = window;
    window.document = document;
    window.history = history;
    window.navigator = sandbox.navigator;
    window.sessionStorage = sessionStorage;
    vm.createContext(sandbox);
    vm.runInContext(settingsSource, sandbox, { filename: 'Settings.js' });

    const page = Object.create(window.SettingsPage.prototype);
    page.tabs = tabs;
    page.tabContents = panels;
    page.app = {
        _histIdx: 4,
        _settingsSubRoute: '',
        currentPage: 'settings',
        currentUser: { cloud, role: cloud ? 'member' : 'user' },
        player: null,
        sourceManager: {
            async loadSources() {},
            loadContentSources() {},
        },
    };
    page.refreshAccountSettings = async () => {};
    page.updateEpgLastRefreshed = async () => {};
    page.initScreensTab = () => {};
    page.loadHardwareInfo = () => {};
    page.loadUsers = () => {};

    return { history, location, page, panels, sessionStorage, tabs, window };
}

test('Settings routes accept only canonical allow-listed sections', () => {
    const { window } = loadSettings();
    const nav = window.NorvaSettingsNavigation;

    assert.equal(nav.tabFromHash('#settings/sources'), 'sources');
    assert.equal(nav.tabFromHash('#settings/%70layer'), 'player');
    assert.equal(nav.tabFromHash('#settings/not-a-section'), '');
    assert.equal(nav.tabFromHash('#movies/sources'), '');
    assert.equal(nav.normalizeTab(' USERS '), 'users');
    assert.equal(nav.normalizeTab('../../admin'), '');
});

test('switching a Settings section replaces the current route and persists it for refresh', () => {
    const { history, location, page, panels, sessionStorage, tabs } = loadSettings();

    assert.equal(page.switchTab('sources'), 'sources');
    assert.equal(location.hash, '#settings/sources');
    assert.equal(sessionStorage.getItem('norva-settings-tab-v1'), 'sources');
    assert.equal(history.pushes.length, 0, 'section changes must not add Back-button steps');
    assert.equal(history.replacements.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(history.state)), {
        page: 'settings',
        idx: 4,
        marker: 'preserved',
        settingsTab: 'sources',
    });
    assert.equal(tabs.find((item) => item.dataset.tab === 'sources').classList.contains('active'), true);
    assert.equal(panels.find((item) => item.id === 'tab-sources').hidden, false);
});

test('show restores the last Settings section and an explicit deep-link takes precedence', async () => {
    const persisted = loadSettings({ persistedTab: 'player' });
    await persisted.page.show();
    assert.equal(persisted.location.hash, '#settings/player');
    assert.equal(persisted.tabs.find((item) => item.dataset.tab === 'player').classList.contains('active'), true);

    const deepLinked = loadSettings({ persistedTab: 'player' });
    deepLinked.page.app._settingsSubRoute = 'sources';
    await deepLinked.page.show();
    assert.equal(deepLinked.location.hash, '#settings/sources');
    assert.equal(deepLinked.sessionStorage.getItem('norva-settings-tab-v1'), 'sources');
});

test('unavailable or stale sections fail closed to Account and repair persisted state', async () => {
    const unavailable = loadSettings({ persistedTab: 'screens', cloud: false });
    await unavailable.page.show();

    assert.equal(unavailable.location.hash, '#settings/account');
    assert.equal(unavailable.sessionStorage.getItem('norva-settings-tab-v1'), 'account');
    assert.equal(unavailable.tabs.find((item) => item.dataset.tab === 'account').classList.contains('active'), true);
});

test('app bootstrap and popstate preserve Settings section routes without pushing history', () => {
    assert.match(appSource, /NorvaSettingsNavigation\?\.tabFromHash\?\.\(window\.location\.hash\)/);
    assert.match(appSource, /NorvaSettingsNavigation\?\.normalizeTab\?\.\(e\.state\?\.settingsTab\)/);
    assert.match(appSource, /this\.pages\.settings\?\.switchTab\?\.\(settingsTab\)/);
    assert.doesNotMatch(settingsSource, /pushState\([^)]*settingsTab/);
});
