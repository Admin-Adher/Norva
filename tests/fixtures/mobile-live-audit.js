/* Offline audit: production markup/CSS/guide; explicit fake catalogue and playback sink.
 * This proves guide interactions, never provider decoding or authenticated source reloads. */
(async () => {
  const markup = new DOMParser().parseFromString(await (await fetch('/app.html')).text(), 'text/html');
  const page = markup.getElementById('page-live');
  page.classList.add('active');
  document.querySelector('main').append(page);
  const channels = Array.from({length: 96}, (_, n) => ({id: String(n), sourceId: n < 48 ? 'qa-a' : 'qa-b',
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
  select.replaceChildren(new Option('Toutes les sources',''),new Option('Catalogue QA A','qa-a'),new Option('Catalogue QA B','qa-b'));
  window.liveAudit = {plays, channels, list, observations:[]};
  const guide = new LiveGuideFusion({channelList:list, epgGuide:{channels:[],programmes:[]}});
  window.liveAudit.guide = guide;
  select.addEventListener('change', () => {
    list.channels = channels.filter(c => !select.value || c.sourceId===select.value);
    guide.render();
  });
  window.NorvaI18n?.setPreference('fr');
  guide.render();
  window.liveAudit.measure = () => ({width:innerWidth,height:innerHeight,
    overflow:document.documentElement.scrollWidth>innerWidth+1,
    targets:[...document.querySelectorAll('#live-guide-fusion button')].map(b=>{
      const r=b.getBoundingClientRect();return {kind:b.className,label:b.getAttribute('aria-label')||b.textContent.trim(),width:r.width,height:r.height};
    }).filter(r=>r.width&&r.height),
    firstRow:document.querySelector('.live-guide-row')?.getBoundingClientRect().toJSON()});
  window.fixtureReady = true;
})().catch(e => { window.fixtureError = String(e); });
