import { mkdirSync, writeFileSync } from 'node:fs';
import { DISCOVERY_FILMS, DISCOVERY_SELECTION_ENABLED, discoveryPlaylist } from '../supabase/functions/_shared/discovery-catalog.mjs';
import { DISCOVERY_SOURCES, DISCOVERY_REVIEW_SOURCES, DISCOVERY_RESEARCH } from '../supabase/functions/_shared/discovery-sources.mjs';
const root = new URL('../public/catalog/', import.meta.url);
mkdirSync(root, { recursive: true });
writeFileSync(new URL('discovery.m3u', root), discoveryPlaylist());
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
writeFileSync(new URL('credits.html', root), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Norva Selection — Credits</title><link rel="stylesheet" href="/css/main.css"></head>
<body><main class="discovery-credits"><a href="/app#home">Norva</a><h1>Norva Selection — Credits</h1>
<p>Norva Selection is temporarily unavailable while all providers are reviewed. No films or live television feeds are currently included.</p>
<p>You can continue using Norva with your own TV provider. Your Norva subscription and eligible trial terms remain unchanged.</p>
<h2>Withdrawn sources under review</h2>
<p>The following references document the previous selection. They are not active feeds or playback recommendations.</p>
<ul>${DISCOVERY_REVIEW_SOURCES.map(source => `<li><a href="${source.website}">${escape(source.name)}</a> — withdrawn</li>`).join('')}</ul>
<h2>Other sources researched</h2>
<ul>${DISCOVERY_RESEARCH.map(source => `<li><a href="${source.website}">${escape(source.name)}</a> — ${escape(source.status)}. ${escape(source.detail)}</li>`).join('')}</ul>
<h2>Blender Open Movies — archived film credits</h2>
<p>These films have also been withdrawn. Their previous Internet Archive references and creator credits are retained below for attribution. Their creators do not endorse Norva.</p>
${DISCOVERY_FILMS.map(film => `<section><h2>${escape(film.title)} (${film.year})</h2><p>${escape(film.credit)}</p><p><a href="${film.licenceUrl}">Creative Commons Attribution ${film.licence}</a> · <a href="${film.rights}">Creator and sharing terms</a> · <a href="https://archive.org/details/${film.archive}">Film source</a></p></section>`).join('\n')}
<a href="/app#home">Return to Norva</a></main></body></html>\n`);
writeFileSync(new URL('sources.json', root), JSON.stringify({
  status: DISCOVERY_SELECTION_ENABLED ? 'active' : 'under_review',
  sources: DISCOVERY_SELECTION_ENABLED ? [{ name: 'Blender Open Movies', kind: 'movie', website: 'https://studio.blender.org/films/', bundledFilms: DISCOVERY_FILMS.length }, ...DISCOVERY_SOURCES] : [],
  withdrawn: [{ name: 'Blender Open Movies', kind: 'movie', website: 'https://studio.blender.org/films/' }, ...DISCOVERY_REVIEW_SOURCES.map(({ name, kind, website }) => ({ name, kind, website }))],
  research: DISCOVERY_RESEARCH,
}, null, 2) + '\n');
