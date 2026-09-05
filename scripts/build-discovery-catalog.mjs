import { mkdirSync, writeFileSync } from 'node:fs';
import { DISCOVERY_FILMS, discoveryPlaylist } from '../supabase/functions/_shared/discovery-catalog.mjs';
const root = new URL('../public/catalog/', import.meta.url);
mkdirSync(root, { recursive: true });
writeFileSync(new URL('discovery.m3u', root), discoveryPlaylist());
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
writeFileSync(new URL('credits.html', root), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Norva Selection — Credits</title><link rel="stylesheet" href="/css/main.css"></head>
<body><main class="discovery-credits"><a href="/app#home">Norva</a><h1>Norva Selection — Credits</h1>
<p>Open films by independent creators. Norva access is included during your eligible 7-day trial, then requires a Norva subscription. The films retain their Creative Commons licences.</p>
<p>Films are streamed from Internet Archive mirrors. Norva does not edit the films or remove their credits. Availability depends on the host and your connection. The creators do not endorse Norva.</p>
${DISCOVERY_FILMS.map(film => `<section><h2>${escape(film.title)} (${film.year})</h2><p>${escape(film.credit)}</p><p><a href="${film.licenceUrl}">Creative Commons Attribution ${film.licence}</a> · <a href="${film.rights}">Creator and sharing terms</a> · <a href="https://archive.org/details/${film.archive}">Film source</a></p></section>`).join('\n')}
<a href="/app#home">Return to Norva</a></main></body></html>\n`);
