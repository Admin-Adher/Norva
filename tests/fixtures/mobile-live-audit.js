/* Offline audit: production markup/CSS/guide; explicit fake catalogue and playback sink.
 * This proves guide interactions, never provider decoding or authenticated source reloads. */
(async () => {
  const markup = new DOMParser().parseFromString(await (await fetch('/app.html')).text(), 'text/html');
  const page = markup.getElementById('page-live');
  page.classList.add('active');
  document.querySelector('main').append(page);
  const channels = Array.from({length: 96}, (_, n) => ({id: String(n), sourceId: n < 48 ? '1' : '2',
    sourceType: 'm3u', name: `Chaîne ${n + 1} HD — actualités et documentaires`,
    groupTitle: n % 2 ? 'Informations internationales' : 'Documentaires', num: n + 1}));
  const plays = [];
  const favorites = new Set();
  const list = {channels, hideBroken: false, currentChannel: null,
    isHidden: () => false, shouldHideByPlayback: () => false,
    isFavorite: (s,id) => favorites.has(s+':'+id),
    toggleFavorite: async (s,id) => { const k=s+':'+id; favorites.has(k)?favorites.delete(k):favorites.add(k); },
    getChannelFamilyKey: c => c.id, getChannelFamilyLabel: c => c.name,
    getChannelFamilyMembers: c => [c], isHealthyChannel: () => true,
    isBrokenChannel: () => false, isDirectHlsChannel: () => false,
    getPlaybackMode: () => 'direct_play', getProxiedImageUrl: () => '/img/norva-app-icon.png',
    refreshPlaybackForChannels: async () => {},
    selectChannel: c => { plays.push(c); },
    reloadLive: async () => {}, getSourceOptions: () => [], getRemoteSearchSources: () => []};
  const select = document.getElementById('source-select');
  select.replaceChildren(new Option('Toutes les sources',''),new Option('Catalogue QA A','m3u:1'),new Option('Catalogue QA B','m3u:2'));
  window.liveAudit = {plays, channels, list, observations:[]};
  const guide = new LiveGuideFusion({channelList:list, epgGuide:{channels:[],programmes:[]}});
  window.liveAudit.guide = guide;
  window.app = {channelList:list, liveGuideFusion:guide};
  // Exercise the production source-change controller; replace only catalogue I/O
  // and the legacy hidden sidebar renderer, not loadChannels or guide behavior.
  Object.assign(list, {sourceSelect:select, container:document.getElementById('channel-list'),
    liveHydrationRunId:0, isLoading:false, sourceDiscoveryError:false,
    isLiveLoadCurrent: id => id===list.liveHydrationRunId,
    loadM3uChannels: async id => {list.channels=channels.filter(c=>c.sourceId===String(id));return true;},
    loadAllChannels: async () => {list.channels=channels.slice();return true;},
    render:()=>{},loadLiveDecorationsAndRefresh:()=>{},maybeSyncRecentsFromCloud:()=>{}});
  list.loadChannels = () => ChannelList.prototype.loadChannels.call(list);
  select.addEventListener('change', list.loadChannels);
  window.NorvaI18n?.setPreference('fr');
  guide.render();
  window.liveAudit.measure = () => ({width:innerWidth,height:innerHeight,
    overflow:document.documentElement.scrollWidth>innerWidth+1,
    targets:[...document.querySelectorAll('#live-guide-fusion button')].map(b=>{
      const r=b.getBoundingClientRect();return {kind:b.className,label:b.getAttribute('aria-label')||b.textContent.trim(),width:r.width,height:r.height};
    }).filter(r=>r.width&&r.height),
    firstRow:document.querySelector('.live-guide-row')?.getBoundingClientRect().toJSON()});
  window.liveAudit.verifyProviderEpg = () => {
    const epg = new EpgGuide(), now = Date.now();
    epg._mergeSourceGuides(new Map(['1', '2'].map(id => [id, { source: { type: 'xtream' }, data: {
      channels: [{ id: 'same.channel', name: 'Same HD' }],
      programmes: [{ channelId: 'same.channel', title: `Programme ${id}`, start: new Date(now - 60000).toISOString(), stop: new Date(now + 60000).toISOString() }]
    } }])));
    guide.app.epgGuide = epg;
    const a = { ...channels[0], tvgId: 'same.channel' }, b = { ...channels[48], tvgId: 'same.channel' };
    const proof = { first: guide.getProgramAt(a, new Date()).title, second: guide.getProgramAt(b, new Date()).title,
      unrelated: guide.getProgramAt({ ...a, sourceId: 'absent' }, new Date()) };
    list.channels = [a, b]; guide.render();
    return proof;
  };
  window.fixtureReady = true;
})().catch(e => { window.fixtureError = String(e); });
