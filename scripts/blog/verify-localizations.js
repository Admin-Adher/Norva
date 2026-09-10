#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splitDocument } = require('./lib/frontmatter');
const { LOCALES, blogPath, parseBlogUrl, loadUi, hashText, checkStructure, loadTranslations, assertNoUnreleasedTranslationPages } = require('./lib/localization');
const { escapeHtml, escapeAttr } = require('./lib/format');
const root = path.resolve(__dirname, '../..');
const content = path.join(root, 'content/blog');
const publicDir = path.join(root, 'public');
const preview = process.argv.includes('--preview');
const complete = process.argv.includes('--expect-complete');
const firstSelection = ['014', '015', '027', '089', '522', '542', '562'];
const read = file => fs.readFileSync(file, 'utf8');
const findings = [];
const checked = [];
const sitemap = read(path.join(publicDir, 'sitemap-blog.xml'));
const statePath = path.join(content, 'translations/published-state.json');
const state = fs.existsSync(statePath) ? JSON.parse(read(statePath)).published : {};
const sources = fs.readdirSync(path.join(content, 'articles')).filter(file => firstSelection.some(id => file.startsWith(id + '-')));
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const expectedLanguageCodes = LOCALES.map(locale => locale.code);

function verifyHubLayout(html, count) {
  const markers = ['data-blog-index', 'class="blog-hero"', 'class="page-title"'];
  if (count > 0) markers.push('class="hero-feature"', 'role="search"', 'class="topic-filters"', 'data-library-empty-reset');
  else markers.push('class="hero-feature hero-feature-empty"');
  if (count > 1) markers.push('class="recent-list"');
  for (const marker of markers) assert.ok(html.includes(marker), `Missing premium hub module: ${marker}`);
}

if (!preview) {
  try {
    const englishState = JSON.parse(read(path.join(content, 'published-state.json'))).published;
    const loaded = fs.readdirSync(path.join(content, 'articles')).filter(file => /\.md$/.test(file) && englishState[String(Number(file.match(/^\d+/)?.[0]))]).map(file => {
      const raw = read(path.join(content, 'articles', file));
      const { data, body } = splitDocument(raw);
      return { data, body, slug: data.slug, sourceHash: hashText(raw) };
    });
    // CI validates every release hash, not only the seven-topic first selection.
    loadTranslations({ contentDir: content, loaded, nowISO: new Date().toISOString() });
    const outputs = assertNoUnreleasedTranslationPages(publicDir, { published: state });
    for (const file of outputs.expected) {
      assert.ok(outputs.actual.includes(file), `Missing released output: ${file}`);
      assert.ok(read(path.join(publicDir, file)).includes('name="robots" content="index,follow"'), `Preview output cannot be deployed: ${file}`);
    }
  } catch (error) { findings.push({ key: 'release-integrity', error: error.message }); }
}

for (const locale of LOCALES) {
  const ui = loadUi(content, locale.code);
  for (const filename of sources) {
    const sourceRaw = read(path.join(content, 'articles', filename));
    const source = splitDocument(sourceRaw);
    const file = locale.code === 'en' ? path.join(content, 'articles', filename) : path.join(content, 'translations', locale.code, filename);
    const key = `${locale.code}/${source.data.slug}`;
    try {
      if (!fs.existsSync(file)) { if (complete) throw new Error('Missing complete translation'); else continue; }
      const raw = read(file), { data, body } = splitDocument(raw);
      if (locale.code !== 'en') {
        assert.equal(data.source_sha256, hashText(sourceRaw));
        checkStructure(source.body, body, key);
        assert.notEqual(body, source.body, 'untranslated English body');
      }
      const route = blogPath(locale.code, source.data.slug);
      const html = read(path.join(publicDir, route, 'index.html'));
      assert.ok(html.includes(`lang="${locale.code}" dir="${locale.dir}" data-norva-document-language="${locale.code}"`), 'document language');
      assert.ok(html.includes(`<h1>${escapeHtml(data.title)}</h1>`), 'translated H1');
      assert.ok(html.includes(`name="description" content="${escapeAttr(data.meta_description)}"`), 'translated description');
      assert.ok(html.includes(`rel="canonical" href="https://norva.tv${route}"`), 'self canonical');
      const noindex = locale.code !== 'en' && preview;
      assert.ok(html.includes(`name="robots" content="${noindex ? 'noindex,nofollow' : 'index,follow'}"`), 'robots state');
      assert.equal((html.match(/<h1\b/g) || []).length, 1);
      assert.equal((html.match(/data-blog-cta="primary"/g) || []).length, 1);
      assert.equal((html.match(/<section class="sources"/g) || []).length, 1);
      assert.ok(html.includes(`<h2 id="sources">${escapeHtml(ui.sources)}</h2>`));
      const ids = [...html.matchAll(/\bid="([^"]*)"/g)].map(match => decode(match[1]));
      assert.equal(new Set(ids).size, ids.length, 'unique DOM IDs');
      assert.ok(!ids.includes(''));
      for (const match of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(decode(match[1])), `missing anchor ${match[1]}`);
      const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
      const article = ld.find(item => item['@type'] === 'BlogPosting');
      assert.equal(article.inLanguage, locale.code);
      assert.equal(article.headline, data.title);
      if (locale.code !== 'en') {
        assert.ok(html.includes(escapeHtml(ui.originalImages)), 'evidence provenance disclosure');
        assert.equal(article.translationOfWork['@id'], source.data.canonical_url);
        if (!noindex) assert.equal(article.datePublished, state[key].published_at);
      }
      const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(match => ({ hreflang: match[1], url: match[2] }));
      if (noindex) assert.equal(alternates.length, 0);
      else if (!preview && complete) {
        assert.equal(alternates.length, 11);
        assert.deepEqual(alternates.map(item => item.hreflang).sort(), [...LOCALES.map(item => item.hreflang), 'x-default'].sort());
        for (const alternate of alternates) {
          const target = new URL(alternate.url);
          assert.equal(target.origin, 'https://norva.tv');
          const other = read(path.join(publicDir, target.pathname, 'index.html'));
          for (const expected of alternates) assert.ok(other.includes(`hreflang="${expected.hreflang}" href="${expected.url}"`), 'reciprocity');
        }
      }
      for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
        const parsed = parseBlogUrl(decode(match[1]));
        if (!parsed) continue;
        const target = path.join(publicDir, blogPath(parsed.code, parsed.slug), 'index.html');
        assert.ok(fs.existsSync(target), `missing local blog target ${match[1]}`);
        const hash = new URL(decode(match[1]), 'https://norva.tv').hash;
        if (hash) assert.ok(read(target).includes(`id="${escapeAttr(decodeURIComponent(hash.slice(1)))}"`), `missing target anchor ${match[1]}`);
      }
      const images = [...html.matchAll(/<img\b[^>]*src="(\/assets\/blog\/[^"#?]+)"/g)].map(match => match[1]);
      for (const image of images) assert.ok(fs.existsSync(path.join(publicDir, image)), image);
      assert.equal(sitemap.includes(`<loc>https://norva.tv${route}</loc>`), !noindex);
      checked.push({ key, route, images: images.length, headings: (body.match(/^## /gm) || []).length, robots: noindex ? 'noindex,nofollow' : 'index,follow' });
    } catch (error) { findings.push({ key, error: error.message }); }
  }
}
if (complete && checked.length !== 70) findings.push({ error: `Expected 70 verified versions, got ${checked.length}` });
let hubsChecked = 0;
for (const code of expectedLanguageCodes) {
  const hub = path.join(publicDir, blogPath(code), 'index.html');
  if (!fs.existsSync(hub)) { if (complete) findings.push({ key: `${code}/index`, error: 'Missing language hub' }); continue; }
  const html = read(hub);
  hubsChecked++;
  if (!html.includes(`data-norva-document-language="${code}"`)) findings.push({ key: `${code}/index`, error: 'Wrong hub language' });
  try {
    const ui = loadUi(content, code);
    const expectedCount = code === 'en'
      ? Object.keys(JSON.parse(read(path.join(content, 'published-state.json'))).published).length
      : Object.keys(state).filter(key => key.startsWith(code + '/')).length;
    if (!preview) assert.ok(html.includes(`data-guide-count="${expectedCount}"`), 'truthful locale count');
    const renderedCount = Number(html.match(/data-guide-count="(\d+)"/)?.[1]);
    assert.ok(Number.isInteger(renderedCount), 'valid rendered guide count');
    verifyHubLayout(html, renderedCount);
    if (renderedCount > 0) {
      assert.ok(html.includes(escapeHtml(ui.hubSearchLabel)), 'localized search label');
      assert.ok(html.includes(escapeHtml(ui.hubNoResults)), 'localized empty state');
    }
    assert.ok(html.includes(`data-status-results="${escapeAttr(ui.hubResults)}"`), 'localized runtime results');
    const cards = [...html.matchAll(/<article class="library-card"[^>]*data-topic="([^"]+)"[^>]*>\s*<a href="([^"]+)"/g)];
    if (!preview) assert.equal(cards.length, expectedCount, 'all localized cards available without JavaScript');
    const english = read(path.join(publicDir, 'blog/index.html'));
    const englishTopics = new Map([...english.matchAll(/<article class="library-card"[^>]*data-topic="([^"]+)"[^>]*>\s*<a href="([^"]+)"/g)].map(match => [parseBlogUrl(match[2]).slug, match[1]]));
    for (const card of cards) {
      const target = parseBlogUrl(card[2]);
      assert.equal(target?.code, code, 'hub card must stay in its language');
      assert.equal(card[1], englishTopics.get(target.slug), 'topic classification must match source');
    }
  } catch (error) { findings.push({ key: `${code}/index`, error: error.message }); }
}
console.log(JSON.stringify({ preview, complete, versionsChecked: checked.length, languageHubs: hubsChecked,
  existingEnglishArticles: Object.keys(JSON.parse(read(path.join(content, 'published-state.json'))).published).length,
  sitemapUrls: (sitemap.match(/<loc>/g) || []).length, checked, findings }, null, 2));
if (findings.length) process.exitCode = 1;
