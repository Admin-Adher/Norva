const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderIndexPage, renderLocalizedIndexPage } = require('../scripts/blog/lib/templates');
const { LOCALES, loadUi, blogPath, alternates, localizeArticles } = require('../scripts/blog/lib/localization');
const { escapeHtml } = require('../scripts/blog/lib/format');
const root = path.resolve(__dirname, '..');
const content = path.join(root, 'content/blog');
const script = fs.readFileSync(path.join(root, 'public/js/blog-index.js'), 'utf8');
const clusters = ['Caption Accessibility', 'Account Security', 'Mobile Viewing Workflows', 'Buffering Diagnostics', 'Metadata Quality', 'Norva Onboarding'];
const articles = Array.from({ length: 7 }, (_, index) => ({
  slug: `guide-${index}`, title: `Guide ${index}`, excerpt: `Answer ${index}`, metaDescription: `Answer ${index}`,
  cluster: 'A translated category', topicCluster: clusters[index % clusters.length],
  canonicalUrl: `https://norva.tv/blog/guide-${index}/`, sequence: index,
  publishedAtISO: '2026-09-10T12:00:00Z', displayDate: '10 September 2026', readingMinutes: 6,
}));

for (const locale of LOCALES) {
  test(`${locale.code}: shared premium structure, reviewed labels, local links and real counts`, () => {
    const ui = loadUi(content, locale.code);
    const links = alternates('', LOCALES.map(item => item.code));
    const input = articles.map(article => ({ ...article, canonicalUrl: `https://norva.tv${blogPath(locale.code, article.slug)}` }));
    const options = { locale, ui, languageLinks: links, alternates: links };
    const html = renderIndexPage(input, options);
    assert.equal(renderLocalizedIndexPage(input, options), html, 'there must not be a second layout');
    for (const marker of ['class="blog-hero"', 'class="page-title"', 'class="hero-feature"', 'class="recent-list"', 'role="search"', 'class="topic-filters"', 'data-library-empty-reset', 'data-library-more']) assert.ok(html.includes(marker), marker);
    assert.match(html, /data-guide-count="7"/);
    assert.match(html, /data-blog-index/);
    assert.equal((html.match(/data-library-item /g) || []).length, 7);
    assert.equal((html.match(/data-topic-filter=/g) || []).length, 7);
    for (const topic of ['start', 'organise', 'anywhere', 'playback', 'accessibility', 'privacy']) assert.ok(html.includes(`data-topic="${topic}"`));
    assert.ok(html.includes(`<html lang="${locale.code}" dir="${locale.dir}"`));
    assert.ok(html.includes(`rel="canonical" href="https://norva.tv${blogPath(locale.code)}"`));
    assert.ok(html.includes(escapeHtml(ui.hubTitleAccent)));
    for (const key of ['hubLatest', 'hubRecent', 'hubLibrary', 'hubSearchLabel', 'hubNoResults', 'hubReset']) assert.ok(html.includes(escapeHtml(ui[key])), key);
    assert.doesNotMatch(html, /data-i18n(?:=|-)/, 'app preferences cannot replace route-specific reviewed text');
    assert.doesNotMatch(html, /localized-library-intro/);
    const destinations = [...html.matchAll(/<a href="([^"#]+guide-\d\/)/g)].map(match => match[1]);
    assert.equal(destinations.length, 12, 'one featured + four recent + seven searchable cards');
    assert.ok(destinations.every(href => href.startsWith(blogPath(locale.code))));
    if (locale.code !== 'en') assert.ok(html.includes(escapeHtml(ui.libraryNotice.replace('{count}', new Intl.NumberFormat(locale.code).format(7)))));
  });
}

test('empty and small hubs expose all available cards without inventing categories or dates', () => {
  for (const count of [0, 1, 3, 5]) {
    const html = renderIndexPage(articles.slice(0, count));
    assert.ok(html.includes(`data-guide-count="${count}"`));
    assert.equal((html.match(/data-library-item /g) || []).length, count);
    assert.doesNotMatch(html, /undefined|NaN|Invalid Date/);
  }
  const html = renderIndexPage([articles[0]]);
  assert.ok(html.includes('data-topic-filter="accessibility"'));
  assert.ok(!html.includes('data-topic-filter="privacy"'), 'do not offer categories with no translated articles');
});

test('HTML interpolation escapes reviewed copy and featured titles', () => {
  const ui = { ...loadUi(content, 'en'), hubTitle: '<script>{accent}</script>', hubTitleAccent: '<img onerror=alert(1)>' };
  const html = renderIndexPage([{ ...articles[0], title: '\"><script>alert(1)</script>' }], { ui });
  assert.ok(html.includes('&lt;script&gt;<span>&lt;img'));
  const body = html.slice(html.indexOf('<body>'));
  assert.ok(!body.includes('<script>alert(1)'), 'visible HTML must escape title markup');
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => JSON.parse(match[1]));
});

test('release layout gate accepts small hubs and rejects missing required modules', () => {
  const verifier = fs.readFileSync(path.join(root, 'scripts/blog/verify-localizations.js'), 'utf8');
  const definition = verifier.match(/^function verifyHubLayout\(html, count\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(definition);
  const verifyLayout = vm.runInNewContext(`(${definition})`, { assert });
  for (const count of [0, 1, 2, 7]) {
    const html = renderIndexPage(articles.slice(0, count));
    assert.doesNotThrow(() => verifyLayout(html, count));
    assert.throws(() => verifyLayout(html.replace('data-blog-index', 'data-removed'), count), /Missing premium hub module/);
    if (count > 0) assert.throws(() => verifyLayout(html.replace('role="search"', ''), count), /Missing premium hub module/);
    if (count > 1) assert.throws(() => verifyLayout(html.replace('class="recent-list"', ''), count), /Missing premium hub module/);
  }
});

test('translated topic mapping uses the original category, not translated words', () => {
  const original = { ...articles[0], cluster: 'Caption Accessibility', headings: [], related: [] };
  const translated = localizeArticles({ english: [original], publicDir: path.join(root, 'public'), translations: [{
    key: 'fr/guide-0', locale: LOCALES.find(locale => locale.code === 'fr'), ui: loadUi(content, 'fr'), source: { slug: 'guide-0' },
    data: { title: 'Sous-titres', seo_title: 'Sous-titres', topic_cluster: 'Accessibilité des sous-titres', excerpt: 'Exemple', meta_description: 'Exemple' },
    body: '## Exemple\n\nUne démonstration.', publishedAtISO: original.publishedAtISO, updatedAtISO: original.publishedAtISO,
  }] });
  assert.equal(translated[0].topicCluster, 'Caption Accessibility');
});

function harness(code = 'fr', size = 7) {
  const ui = loadUi(content, code);
  const element = extra => ({ hidden: false, value: '', textContent: '', dataset: {}, handlers: {},
    classList: { toggle() {}, add() {} }, setAttribute(key, value) { this[key] = value; },
    addEventListener(key, callback) { this.handlers[key] = callback; }, focus() { this.focused = true; }, ...extra });
  const controls = Object.fromEntries(['index-highlights', 'library-search', 'library-query', 'library-clear', 'library-reset', 'library-empty-reset', 'library-status', 'library-empty', 'library-more'].map(name => [`[data-${name}]`, element()]));
  const items = Array.from({ length: size }, (_, i) => element({ textContent: i === 0 ? 'Éléphant français İSTANBUL' : `Guide numéro ${i}`, dataset: { topic: i % 2 ? 'organise' : 'start', highlighted: String(i < 5) } }));
  const buttons = ['all', 'start', 'organise'].map(topic => element({ dataset: { topicFilter: topic } }));
  const rootNode = element({ dataset: { blogLanguage: code, statusResults: ui.hubResults, statusRemaining: ui.hubRemaining },
    querySelector: selector => controls[selector], querySelectorAll: selector => selector === '[data-topic-filter]' ? buttons : items });
  vm.runInNewContext(script, { document: { querySelector: () => rootNode }, Intl,
    NorvaI18n: { t() { throw new Error('App language must not override a blog route'); } } });
  const control = name => controls[`[data-${name}]`];
  const input = value => { control('library-query').value = value; control('library-query').handlers.input(); };
  const visible = () => items.filter(item => !item.hidden);
  return { ui, control, items, buttons, input, visible };
}

test('search, clear, Escape, topics, empty recovery and counts use the route language', () => {
  const h = harness('fr');
  assert.equal(h.visible().length, 2);
  h.input('elephant francais');
  assert.equal(h.visible().length, 1, 'Latin accent-insensitive multiword matching');
  assert.equal(h.control('library-status').textContent, h.ui.hubResults.replace('{count}', '1'));
  assert.equal(h.control('index-highlights').hidden, true);
  h.control('library-query').handlers.keydown({ key: 'Escape' });
  assert.equal(h.control('library-query').value, '');
  h.buttons[2].handlers.click();
  assert.equal(h.visible().length, 3);
  assert.equal(h.buttons[2]['aria-pressed'], 'true');
  h.input('no-such-guide-404');
  assert.equal(h.visible().length, 0);
  assert.equal(h.control('library-empty').hidden, false);
  h.control('library-empty-reset').handlers.click();
  assert.equal(h.visible().length, 2);
  assert.equal(h.control('library-query').focused, true);
  h.input('éléphant');
  h.control('library-clear').handlers.click();
  assert.equal(h.control('library-query').value, '');
  assert.equal(h.control('library-empty').hidden, true);
});

test('Turkish case matching and Arabic counts do not use browser or app language', () => {
  const tr = harness('tr'); tr.input('istanbul');
  assert.equal(tr.visible().length, 1);
  const ar = harness('ar'); ar.input('guide');
  assert.equal(ar.control('library-status').textContent, ar.ui.hubResults.replace('{count}', new Intl.NumberFormat('ar').format(6)));
});

test('pagination is incremental, while a one-article hub never hides its only library card', () => {
  const h = harness('en', 30);
  assert.equal(h.visible().length, 12);
  h.control('library-more').handlers.click();
  assert.equal(h.visible().length, 24);
  h.control('library-more').handlers.click();
  assert.equal(h.visible().length, 25);
  assert.equal(h.control('library-more').hidden, true);
  assert.equal(harness('fr', 1).visible().length, 1);
});
