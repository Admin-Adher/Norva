import { mkdirSync, writeFileSync } from 'node:fs';
import { DISCOVERY_FILMS, discoveryPlaylist } from '../supabase/functions/_shared/discovery-catalog.mjs';
import { DISCOVERY_SOURCES, DISCOVERY_RESEARCH } from '../supabase/functions/_shared/discovery-sources.mjs';
const root = new URL('../public/catalog/', import.meta.url);
mkdirSync(root, { recursive: true });
writeFileSync(new URL('discovery.m3u', root), discoveryPlaylist());
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
writeFileSync(new URL('credits.html', root), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Norva Selection — Credits</title><link rel="stylesheet" href="/css/main.css"></head>
<body><main class="discovery-credits"><a href="/app#home">Norva</a><h1>Norva Selection — Credits</h1>
<p>Films and live television from several public playlists, together in Norva Selection. Norva access is included during your eligible 7-day trial, then requires a Norva subscription.</p>
<p>Use the source's Sync action in Norva to refresh the selection. Films appear in Movies; television appears in Live TV. Repeated media URLs are merged. Regional editions, languages and alternate streams can still represent the same programme.</p>
<p>Media stays with its original hosts. Availability, advertising and territorial restrictions depend on each provider. Inclusion is not an endorsement or a promise that every stream works in every country. Norva does not remove advertising, credits or access restrictions.</p>
<h2>Playlist sources</h2>
<p>The following feeds are fetched when your selection is synchronized. A temporarily unavailable feed does not prevent the other feeds from loading.</p>
<ul>${DISCOVERY_SOURCES.map(source => `<li><a href="${source.website}">${escape(source.name)}</a> — ${source.kind === 'movie' ? 'On demand' : 'Live television'}</li>`).join('')}</ul>
<p>PublicDomainM3U describes its curation as public domain in the United States. The Pluto playlist repository specifies personal use; Pluto content remains the property of its respective owners. Provider terms and local availability still apply. The Creative Commons licences below apply only to the named Blender films.</p>
<h2>Other sources researched</h2>
<ul>${DISCOVERY_RESEARCH.map(source => `<li><a href="${source.website}">${escape(source.name)}</a> — ${escape(source.status)}. ${escape(source.detail)}</li>`).join('')}</ul>
<h2>Blender Open Movies — film credits</h2>
<p>These films are streamed from Internet Archive mirrors, with their original credits preserved. Their creators do not endorse Norva.</p>
${DISCOVERY_FILMS.map(film => `<section><h2>${escape(film.title)} (${film.year})</h2><p>${escape(film.credit)}</p><p><a href="${film.licenceUrl}">Creative Commons Attribution ${film.licence}</a> · <a href="${film.rights}">Creator and sharing terms</a> · <a href="https://archive.org/details/${film.archive}">Film source</a></p></section>`).join('\n')}
<a href="/app#home">Return to Norva</a></main></body></html>\n`);
writeFileSync(new URL('sources.json', root), JSON.stringify({
  sources: [{ name: 'Blender Open Movies', kind: 'movie', website: 'https://studio.blender.org/films/', bundledFilms: DISCOVERY_FILMS.length }, ...DISCOVERY_SOURCES],
  research: DISCOVERY_RESEARCH,
}, null, 2) + '\n');
