'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ phone = true, tv = false, sidebar = false } = {}) {
  const source = { value: 'xtream:2' };
  const listeners = new Map();
  const container = { innerHTML: '', classList: { toggle() {} },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (type, listener) => listeners.set(type, listener) };
  const window = { addEventListener() {} };
  const document = { activeElement: null,
    getElementById: id => id === 'source-select' ? source : id === 'channel-sidebar' && sidebar ? {} : null,
    querySelector: () => null,
    body: { classList: { contains: name => phone && name === 'norva-phone-apk' } },
    documentElement: { classList: { contains: name => tv && name === 'tv-mode' } } };
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} } });
  for (const component of ['ChannelList', 'LiveGuideFusion']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components', `${component}.js`), 'utf8'), context);
  }
  const tf1 = { id: 'tf1', streamId: '17', sourceId: 2, sourceType: 'xtream', name: 'BE: TF1 HD', groupTitle: 'Belgium' };
  const arabic = { id: 'arabic', streamId: '8', sourceId: 2, sourceType: 'xtream', name: '### ARABIC 24/7 4K ###', groupTitle: '24/7' };
  const list = Object.create(window.ChannelList.prototype);
  const played = [];
  Object.assign(list, { channels: [arabic, tf1], sourceSelect: source,
    isHidden: () => false, isFavorite: () => false, isHealthyChannel: () => true,
    isBrokenChannel: () => false, isDirectHlsChannel: () => false, getPlaybackMode: () => 'direct_play',
    getChannelLogoSrc: () => '', getChannelLogoErrorSrc: () => '',
    selectChannel: target => played.push(target), findLastLiveChannel: () => tf1 });
  const guide = Object.create(window.LiveGuideFusion.prototype);
  Object.assign(guide, { app: { channelList: list }, container, currentChannel: tf1, activeGroup: '',
    ensureShortEpgForChannels() {}, getProgramAt: () => null, getProgress: () => 0,
    getUpcoming: () => [], getRowsChannels: () => list.channels,
    renderRows: channels => channels.map(channel => channel.name).join(','),
    renderToolbar: () => '',
    _applyCinema() {}, refreshFamilyIfNeeded() {} });
  guide.init();
  // The identity comes from the real rendered Watch button, not a hand-built
  // object that could disagree with the product's event wiring.
  const watch = html => {
    const tag = html.match(/<button\b[^>]*data-action="watch"[^>]*>/)?.[0];
    assert.ok(tag, 'The real preview must expose its Watch action');
    const dataset = {};
    for (const [, name, value] of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      dataset[name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
    return { dataset };
  };
  const click = button => listeners.get('click')({ target: {
    closest: selector => selector === '[data-action]' ? button : null
  } });
  return { guide, list, source, tf1, arabic, played, container, watch, click };
}

test('Watch follows the displayed TF1 identity when a later render changes the preview selection', () => {
  const { guide, arabic, tf1, played, watch, click } = fixture();
  guide.render();
  const displayedWatch = watch(guide.renderPreview(tf1));
  guide.setActiveChannel(arabic);
  // A queued activation still belongs to the button the viewer pressed.
  click(displayedWatch);
  assert.equal(played.length, 1);
  assert.equal(played[0].channelId, tf1.id);
  assert.equal(played[0].streamId, tf1.streamId);
});

test('a stale TF1 button cannot silently play the first row when its channel left the loaded page', () => {
  const { guide, list, tf1, arabic, played, watch, click } = fixture();
  const displayedWatch = watch(guide.renderPreview(tf1));
  list.channels = [arabic];
  guide.render();
  click(displayedWatch);
  assert.equal(played.length, 0);
});

test('a Watch button from the previous source cannot select a colliding channel id', () => {
  const { guide, list, source, tf1, played, watch, click } = fixture();
  const displayedWatch = watch(guide.renderPreview(tf1));
  source.value = 'm3u:2';
  const differentSource = { ...tf1, sourceType: 'm3u', name: 'Different source' };
  list.channels = [differentSource];
  guide.currentChannel = differentSource;
  click(displayedWatch);
  assert.equal(played.length, 0);
});

test('a failed catalogue render leaves the displayed selection unchanged until the DOM commits', () => {
  const { guide, list, container, tf1, arabic } = fixture();
  guide.render();
  const previousHtml = container.innerHTML;
  list.channels = [arabic];
  guide.renderRows = () => { throw new Error('Malformed later catalogue row'); };
  assert.throws(() => guide.render(), /Malformed later catalogue row/);
  assert.equal(container.innerHTML, previousHtml);
  assert.equal(guide.currentChannel.id, tf1.id);
});

test('an ordinary current Watch action still chooses a healthy variant of the displayed family', () => {
  for (const zeroIdentity of [false, true]) {
    const { guide, list, source, tf1, played, watch, click } = fixture();
    if (zeroIdentity) {
      tf1.id = 0;
      tf1.sourceId = 0;
      source.value = 'xtream:0';
    }
    const hd = { ...tf1, id: 'tf1-hd', streamId: '18', name: 'BE: TF1 HD' };
    list.channels.push(hd);
    list.isHealthyChannel = channel => channel === hd;
    click(watch(guide.renderPreview(tf1)));
    assert.equal(played.length, 1);
    assert.equal(played[0].channelId, hd.id);
    assert.equal(played[0].sourceId, String(tf1.sourceId));
  }
});

test('web with a sidebar shows only the selected channel and requests its programme, without a second browse list', () => {
  const { guide, container, tf1, played, watch, click } = fixture({ phone: false, sidebar: true });
  let wanted;
  guide.app.epgGuide = { ensureChannels: channels => { wanted = channels; } };
  guide.renderRows = () => { throw new Error('Web must use the sidebar for navigation'); };
  guide.render();
  assert.equal(wanted.length, 1);
  assert.equal(wanted[0], tf1);
  assert.match(container.innerHTML, /BE: TF1 HD/);
  assert.doesNotMatch(container.innerHTML, /live-guide-rows|live-guide-groups|ARABIC/);
  click(watch(container.innerHTML));
  assert.equal(played[0].channelId, tf1.id);
});

test('phone and TV retain their channel navigation even when the shared document contains the web sidebar', () => {
  for (const options of [{ phone: true, sidebar: true }, { phone: false, tv: true, sidebar: true }]) {
    const { guide } = fixture(options);
    assert.equal(guide.usesSidebarNavigation(), false);
  }
});
