/* Actual production controllers and rendering. Only catalogue I/O/EPG/decorations
 * are fixture data. Every HTTP request is intercepted by the Android harness. */
(async () => {
  localStorage.clear();
  const markup = new DOMParser().parseFromString(await (await fetch('/app.html')).text(), 'text/html');
  const page = markup.getElementById('page-live');
  page.classList.add('active');
  document.querySelector('main').append(page);
  document.body.append(markup.getElementById('context-menu'));
  const sources = [1, 2].map(id => ({id, type: 'xtream', enabled: true, name: `Catalogue QA ${id}`}));
  const channels = ['TF1 HD', 'France 2 HD', 'Arte HD', 'TF1 FHD', 'M6 HD', 'Culture HD'].map((name, n) => ({
    id: `fixture-${n + 1}`, streamId: String(n + 1), sourceId: n < 3 ? 1 : 2,
    sourceType: 'xtream', name, groupTitle: n % 3 === 2 ? 'Documentaires' : 'Actualités', num: n + 1
  }));
  const pending = [];
  window.API = {
    isCloudMode: () => true,
    sources: {getAll: async () => sources},
    proxy: {xtream: {
      shortEpg: async () => ({epg_listings: []}),
      liveStreams: (sourceId, category, options) => {
        if (!options?.q) throw new Error('Unexpected non-search catalogue I/O');
        return new Promise(resolve => pending.push({sourceId: String(sourceId), query: options.q, resolve}));
      }
    }}
  };
  const list = new ChannelList();
  // Substitute external data boundaries, retaining loadSources/loadChannels,
  // source-change handlers, search, render, decorations refresh and LivePage.
  list.loadXtreamChannels = async id => {
    list.channels = channels.filter(c => c.sourceId === Number(id)).map(c => ({...c}));
    list.groups = [];
    return true;
  };
  list.loadAllChannels = async () => {
    list.channels = channels.map(c => ({...c}));
    list.groups = [];
    list.render();
    return true;
  };
  list.loadHiddenItems = list.loadFavorites = list.loadPlaybackStatuses = async () => {};
  const app = {channelList: list, player: {getCountry: () => 'FR'},
    epgGuide: {channels: [], programmes: [], getCurrentProgram: () => null, fetchEpgData: async () => {}}};
  window.app = app;
  const guide = app.liveGuideFusion = new LiveGuideFusion(app);
  const livePage = new LivePage(app);
  window.NorvaI18n?.setPreference('fr');
  await livePage.init();
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const audit = window.liveSearchAudit = {list, guide, livePage, pending, channels,
    async verifyRender() {
      const input = list.searchInput;
      input.value = 'TF1';
      list.onSearchInput();
      list.render();
      await livePage.show();
      check(input.value === 'TF1' && list.searchMode, 'TF1 sidebar query was lost');
      const rows = [...list.container.querySelectorAll('.search-result')];
      check(rows.length === 2 && rows.every(row => row.querySelector('.channel-name').textContent.includes('TF1')),
        'Sidebar render replaced TF1 results with browse');
      const mobile = document.querySelector('.live-guide-search');
      mobile.setSelectionRange(2, 2);
      guide.render();
      const rendered = document.querySelector('.live-guide-search');
      check(rendered.value === 'TF1' && rendered.selectionStart === 2 && document.activeElement === rendered,
        'Mobile TF1 query/focus/caret was lost during render');
      audit.renderVerified = true;
    },
    async verifyRemoteSourceRace() {
      clearTimeout(list.remoteSearchInFlight);
      clearTimeout(guide._remoteSearchTimer);
      ++list.remoteSearchSeq;
      ++guide._remoteSearchSeq;
      pending.splice(0).forEach(request => request.resolve([]));
      await settle();
      // A cancelled request may still populate its per-source cache before its
      // generation guard returns. Clear only after those promises have settled.
      list.remoteSearchCache.clear();
      list.sourceSelect.value = 'xtream:1';
      await list.onSourceFilterChange();
      clearTimeout(list.remoteSearchInFlight);
      const old = list.loadRemoteSearchResults('TF1', ++list.remoteSearchSeq);
      const previous = pending.shift();
      check(previous?.sourceId === '1', 'Old search did not target source A');
      list.sourceSelect.value = 'xtream:2';
      await list.onSourceFilterChange();
      clearTimeout(list.remoteSearchInFlight);
      previous.resolve([{stream_id: 901, name: 'TF1 OLD A', category_name: 'Actualités'}]);
      await old;
      check(!list.channels.some(c => String(c.streamId) === '901'), 'Stale source A response contaminated catalogue B');
      const fresh = list.loadRemoteSearchResults('TF1', ++list.remoteSearchSeq);
      const current = pending.shift();
      check(current?.sourceId === '2', 'Current search did not target source B');
      current.resolve([{stream_id: 902, name: 'TF1 NEW B', category_name: 'Actualités'}]);
      await fresh;
      check(list.channels.some(c => String(c.streamId) === '902'), 'Current B search was discarded');
      list.render();
      guide.render();
      const rows = [...list.container.querySelectorAll('.search-result')];
      check(rows.length > 0 && rows.every(row => row.dataset.sourceId === '2'), 'Search results escaped source B');
      check(guide.getRowsChannels().every(c => c.sourceId === 2 || c.sourceId === '2'), 'Guide results escaped source B');
      audit.remoteVerified = true;
    },
    async verifyMobileRemoteSourceRace() {
      list.searchInput.value = '';
      clearTimeout(list.remoteSearchInFlight);
      clearTimeout(guide._remoteSearchTimer);
      ++list.remoteSearchSeq;
      ++guide._remoteSearchSeq;
      pending.splice(0).forEach(request => request.resolve([]));
      await settle();
      list.remoteSearchCache.clear();
      list.sourceSelect.value = 'xtream:1';
      await list.onSourceFilterChange();
      const old = guide.loadRemoteSearchResults('TF1', ++guide._remoteSearchSeq);
      const previous = pending.shift();
      check(previous?.sourceId === '1', 'Mobile old search did not target A');
      list.sourceSelect.value = 'xtream:2';
      await list.onSourceFilterChange();
      previous.resolve([{stream_id: 903, name: 'TF1 MOBILE OLD A', category_name: 'Actualités'}]);
      await old;
      check(!list.channels.some(c => String(c.streamId) === '903'), 'Mobile stale A response contaminated B');
      const fresh = guide.loadRemoteSearchResults('TF1', ++guide._remoteSearchSeq);
      const current = pending.shift();
      check(current?.sourceId === '2', 'Mobile current search did not target B');
      current.resolve([{stream_id: 904, name: 'TF1 MOBILE NEW B', category_name: 'Actualités'}]);
      await fresh;
      check(list.channels.some(c => String(c.streamId) === '904'), 'Mobile current B response was discarded');
      check(guide.getRowsChannels().every(c => String(c.sourceId) === '2'), 'Mobile results escaped B');
      audit.mobileRemoteVerified = true;
    },
    async verifyFilterOrder(sourceFirst) {
      list.searchInput.value = '';
      const mobile = document.querySelector('.live-guide-search');
      mobile.value = '';
      mobile.dispatchEvent(new Event('input', {bubbles: true}));
      list.sourceSelect.value = 'xtream:2';
      await list.onSourceFilterChange();
      document.querySelector('.live-guide-group[data-group="Documentaires"]').click();
      const allCategories = () => document.querySelector('.live-guide-group[data-group=""]').click();
      const allSources = async () => { list.sourceSelect.value = ''; await list.onSourceFilterChange(); };
      if (sourceFirst) { await allSources(); allCategories(); }
      else { allCategories(); await allSources(); }
      await settle();
      check(list.sourceSelect.value === '' && guide.activeGroup === '', 'Filters did not return to all');
      check(guide.getRowsChannels().length === channels.length, 'Filter order left an incomplete catalogue');
      check(document.activeElement?.classList.contains('live-guide-search'), 'Filter rerender lost search focus');
      check(document.documentElement.scrollWidth <= innerWidth + 1, 'Guide overflow');
      audit[sourceFirst ? 'sourceFirstVerified' : 'categoryFirstVerified'] = true;
    }
  };
  window.fixtureReady = true;
})().catch(error => { window.fixtureError = String(error); });
