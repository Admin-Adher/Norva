const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/blog/build-blog');
const { splitDocument } = require('../scripts/blog/lib/frontmatter');
const { LOCALES, hashText, blogPath } = require('../scripts/blog/lib/localization');
const { loadTranslationSelection } = require('../scripts/blog/lib/selection');
const { verifyLocalizations } = require('../scripts/blog/verify-localizations');
const { comparePageHtml, verifyLiveLocalizations } = require('../scripts/blog/verify-live-localizations');
const EN = require('../content/blog/i18n/ui/en.json');
const repository = path.resolve(__dirname, '..');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-blog-batch-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const content = path.join(directory, 'content/blog');
  const read = file => fs.readFileSync(path.join(directory, file), 'utf8');
  const write = (file, text) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const sourceDates = { '1': '2026-01-01T12:00:00Z', '2': '2026-02-01T12:00:00Z' };
  const sourceFile = id => `content/blog/articles/${String(id).padStart(3, '0')}-guide-${id}.md`;
  const document = (data, body) => '---\n' + Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n' + body;
  const body = (title, answer) => `# ${title}\n\n## Answer\n\n${answer}\n\n## Your next step\n\n[Open Norva](/app#home)\n\n## Sources\n\n- [Primary](https://norva.tv/)\n`;
  for (const id of [1, 2]) {
    write(sourceFile(id), document({
      title: `Guide ${id}`, slug: `guide-${id}`, canonical_url: `https://norva.tv/blog/guide-${id}/`,
      meta_description: `Description ${id}`, excerpt: `Answer ${id}`, topic_cluster: 'Norva Onboarding',
    }, body(`Guide ${id}`, `A concrete source example ${id}.`)));
  }
  write('public/.fixture', '');
  write('public/robots.txt', 'User-agent: *\nAllow: /\nSitemap: https://norva.tv/sitemap-blog.xml\n');
  write('content/blog/publication-calendar.csv', 'sequence,scheduled_publish_at,content_id,slug,title,cluster\n1,2026-01-01T12:00:00Z,1,guide-1,Guide 1,Norva Onboarding\n2,2026-02-01T12:00:00Z,2,guide-2,Guide 2,Norva Onboarding\n');
  write('content/blog/published-state.json', JSON.stringify({ published: sourceDates }));
  const selection = { schema_version: 1, batches: [1, 2].map(id => ({
    id: `batch-${id}`, sources: [{ content_id: id, source_slug: `guide-${id}`, source_published_at: sourceDates[id] }],
  })) };
  write('content/blog/translations/selection.json', JSON.stringify(selection));
  for (const locale of LOCALES) write(`content/blog/i18n/ui/${locale.code}.json`, JSON.stringify(EN));
  const sourceUiHash = hashText(read('content/blog/i18n/ui/en.json'));
  const reviews = { owner_release_authorized: true, source_ui_sha256: sourceUiHash, articles: {}, ui: {} };
  for (const locale of LOCALES.filter(item => item.code !== 'en')) {
    reviews.ui[locale.code] = { source_sha256: sourceUiHash, sha256: sourceUiHash, method: 'ai_assisted_cross_review', decision: 'approved' };
  }
  const addTranslations = (id, approved = true) => {
    const source = read(sourceFile(id));
    for (const locale of LOCALES.filter(item => item.code !== 'en')) {
      const title = `${locale.code} Guide ${id}`;
      const raw = document({
        language: locale.code, source_slug: `guide-${id}`, source_sha256: hashText(source),
        title, seo_title: title, meta_description: `${locale.code} description`, excerpt: `${locale.code} answer`,
        topic_cluster: 'A translated category', sources_heading: EN.sources, next_step_heading: EN.nextStep,
        translation_status: approved ? 'approved' : 'in_review', translation_method: 'ai_assisted',
      }, body(title, `${locale.code} translated example ${id}.`));
      write(`content/blog/translations/${locale.code}/${String(id).padStart(3, '0')}-guide-${id}.md`, raw);
      if (approved) reviews.articles[`${locale.code}/guide-${id}`] = {
        source_sha256: hashText(source), translation_sha256: hashText(raw), method: 'ai_assisted_cross_review', decision: 'approved',
      };
    }
    write('content/blog/translations/reviewed.json', JSON.stringify(reviews));
  };
  return { directory, content, read, write, selection, sourceDates, sourceFile, addTranslations };
}

test('the cumulative production manifest explicitly selects 17 unique published topics and 170 versions', () => {
  const selection = loadTranslationSelection(path.join(repository, 'content/blog'));
  assert.equal(selection.sources.length, 17);
  assert.equal(selection.sources.length * LOCALES.length, 170);
  assert.deepEqual(selection.sources.map(source => source.content_id), [14, 15, 27, 89, 522, 542, 562, 28, 161, 422, 442, 502, 561, 582, 602, 662, 721]);
  assert.equal(new Set(selection.sources.map(source => source.source_slug)).size, 17);
});

test('selection rejects duplicates, absent files, renamed English URLs and changed original dates', t => {
  const f = fixture(t);
  assert.equal(loadTranslationSelection(f.content).sources.length, 2);
  const manifestPath = 'content/blog/translations/selection.json';
  const original = f.read(manifestPath);
  const duplicate = structuredClone(f.selection);
  duplicate.batches[1].sources.push(duplicate.batches[0].sources[0]);
  f.write(manifestPath, JSON.stringify(duplicate));
  assert.throws(() => loadTranslationSelection(f.content), /duplicate selected source ID/);
  f.write(manifestPath, original);
  const source = f.read(f.sourceFile(1));
  f.write(f.sourceFile(1), source.replace('https://norva.tv/blog/guide-1/', 'https://norva.tv/blog/renamed/'));
  assert.throws(() => loadTranslationSelection(f.content), /URL identity changed/);
  f.write(f.sourceFile(1), source);
  const state = f.read('content/blog/published-state.json');
  f.write('content/blog/published-state.json', JSON.stringify({ published: { ...f.sourceDates, '1': '2030-01-01T00:00:00Z' } }));
  assert.throws(() => loadTranslationSelection(f.content), /original publication date changed/);
  f.write('content/blog/published-state.json', state);
  fs.unlinkSync(path.join(f.directory, f.sourceFile(2)));
  assert.throws(() => loadTranslationSelection(f.content), /exactly one file/);
});

test('a later batch stays incomplete without invalidating reviewed releases, then adds dates and alternates atomically', t => {
  const f = fixture(t);
  f.addTranslations(1);
  const firstInstant = '2026-09-10T12:00:00.000Z', secondInstant = '2026-09-11T12:00:00.000Z';
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'], nowMs: Date.parse(firstInstant) });
  const firstState = JSON.parse(f.read('content/blog/translations/published-state.json'));
  const englishState = f.read('content/blog/published-state.json');
  const before = verifyLocalizations({ root: f.directory, args: [] });
  assert.equal(before.versionsChecked, 10);
  assert.equal(before.expectedVersions, 20);
  assert.deepEqual(before.findings, []);
  const incomplete = verifyLocalizations({ root: f.directory, args: ['--expect-complete'] });
  assert.ok(incomplete.findings.some(item => /Expected 20 verified versions/.test(item.error)));
  assert.ok(incomplete.findings.some(item => /Missing complete translation/.test(item.error)));
  f.addTranslations(2, false);
  assert.deepEqual(verifyLocalizations({ root: f.directory, args: [] }).findings, []);
  assert.throws(() => main({ root: f.directory, args: ['--existing-only', '--publish-translations'] }), /not approved/);
  assert.deepEqual(JSON.parse(f.read('content/blog/translations/published-state.json')), firstState);
  f.addTranslations(2);
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'], nowMs: Date.parse(secondInstant) });
  const finalState = JSON.parse(f.read('content/blog/translations/published-state.json'));
  for (const [key, entry] of Object.entries(firstState.published)) assert.deepEqual(finalState.published[key], entry);
  for (const locale of LOCALES.filter(item => item.code !== 'en')) {
    const entry = finalState.published[`${locale.code}/guide-2`];
    assert.equal(entry.published_at, secondInstant);
    assert.equal(entry.updated_at, secondInstant);
  }
  assert.equal(f.read('content/blog/published-state.json'), englishState);
  const complete = verifyLocalizations({ root: f.directory, args: ['--expect-complete'] });
  assert.equal(complete.versionsChecked, 20);
  assert.equal(complete.expectedVersions, 20);
  assert.deepEqual(complete.findings, []);
  const sitemap = f.read('public/sitemap-blog.xml');
  assert.match(sitemap, /<loc>https:\/\/norva\.tv\/blog\/<\/loc>\s*<lastmod>2026-02-01<\/lastmod>/, 'translation releases do not redate the English hub');
  assert.match(sitemap, /<loc>https:\/\/norva\.tv\/blog\/fr\/<\/loc><lastmod>2026-09-11<\/lastmod>/, 'the translated hub follows its own latest release');
  const secondHtml = f.read('public/blog/fr/guide-2/index.html');
  assert.equal((secondHtml.match(/<link rel="alternate"/g) || []).length, 11);
  main({ root: f.directory, args: ['--existing-only'], nowMs: Date.parse('2035-01-01T00:00:00Z') });
  assert.equal(f.read('public/blog/fr/guide-2/index.html'), secondHtml);
  assert.deepEqual(JSON.parse(f.read('content/blog/translations/published-state.json')), finalState);
  f.write('public/blog/fr/guide-2/index.html', secondHtml.replace(`"dateModified": "${secondInstant}"`, '"dateModified": "2020-01-01T00:00:00Z"'));
  const stale = verifyLocalizations({ root: f.directory, args: ['--expect-complete'] });
  assert.ok(stale.findings.some(item => item.key === 'fr/guide-2' && /modification date/.test(item.error)));
});

test('an older English guide revision updates hub lastmod without rewriting publication dates', t => {
  const f = fixture(t);
  const source = f.read(f.sourceFile(1)), { data, body } = splitDocument(source);
  const revisedAt = '2026-09-15T12:00:00Z';
  f.write(f.sourceFile(1), '---\n' + Object.entries({ ...data, updated_at: revisedAt }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n' + body);
  const state = f.read('content/blog/published-state.json');
  main({ root: f.directory, args: ['--existing-only'] });
  const sitemap = f.read('public/sitemap-blog.xml');
  assert.match(sitemap, /<loc>https:\/\/norva\.tv\/blog\/<\/loc>\s*<lastmod>2026-09-15<\/lastmod>/);
  const html = f.read('public/blog/guide-1/index.html');
  assert.ok(html.includes(`"datePublished": "${f.sourceDates[1]}"`));
  assert.ok(html.includes(`"dateModified": "${revisedAt}"`));
  assert.equal(f.read('content/blog/published-state.json'), state);
});

test('live comparison verifies JSON-LD dates and identity even when visible content is identical', () => {
  const metadata = {
    '@type': 'BlogPosting', datePublished: '2026-08-01T00:00:00Z', dateModified: '2026-09-10T12:00:00Z',
    inLanguage: 'fr', translationOfWork: { '@id': 'https://norva.tv/blog/original/', inLanguage: 'en' },
  };
  const page = value => `<html lang="fr" dir="ltr"><head><title>Guide</title><link rel="canonical" href="https://norva.tv/blog/fr/original/"><meta name="robots" content="index,follow"><script type="application/ld+json">${JSON.stringify(value)}</script></head><body><main><h1>Guide</h1><p>Same reviewed body.</p></main></body></html>`;
  const expected = page(metadata);
  assert.deepEqual(comparePageHtml(expected, expected), []);
  assert.deepEqual(comparePageHtml(page(Object.fromEntries(Object.entries(metadata).reverse())), expected), [], 'object-key ordering is not a metadata change');
  for (const key of ['datePublished', 'dateModified', 'inLanguage', 'translationOfWork']) {
    const actual = page({ ...metadata, [key]: key === 'translationOfWork' ? { '@id': 'https://norva.tv/blog/wrong/' } : 'changed' });
    assert.ok(comparePageHtml(actual, expected).some(issue => /JSON-LD differs/.test(issue)), key);
  }
  assert.ok(comparePageHtml(expected.replace(JSON.stringify(metadata), '{broken}'), expected).some(issue => /Invalid JSON-LD/.test(issue)));
  assert.ok(comparePageHtml(expected.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''), expected).some(issue => /JSON-LD differs/.test(issue)));
});

test('live worker reports a stale schema date on its exact route without network access', async t => {
  const f = fixture(t);
  f.addTranslations(1);
  f.addTranslations(2);
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'], nowMs: Date.parse('2026-09-10T12:00:00Z') });
  const report = await verifyLiveLocalizations({
    root: f.directory, origin: 'http://127.0.0.1:4181', args: [],
    fetch: async url => {
      const route = new URL(url).pathname;
      const file = route.endsWith('/') ? `public${route}index.html` : `public${route}`;
      let text = f.read(file);
      if (route === blogPath('fr', 'guide-2')) text = text.replace(/"dateModified": "[^"]+"/, '"dateModified": "2020-01-01T00:00:00Z"');
      return new Response(text, { status: 200, headers: { 'content-type': route.endsWith('/') ? 'text/html' : 'text/plain' } });
    },
  });
  assert.equal(report.publicPages, 30);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].route, '/blog/fr/guide-2/');
  assert.ok(report.failures[0].issues.some(issue => /JSON-LD differs/.test(issue)));
});

test('live comparison detects a stale search description even when body and schema match', () => {
  const expected = '<html lang="en"><head><title>Guide</title><meta name="description" content="Reviewed description"></head><body><main><h1>Guide</h1></main></body></html>';
  assert.deepEqual(comparePageHtml(expected, expected), []);
  assert.deepEqual(comparePageHtml(expected.replace('Reviewed description', 'Old description'), expected), ['description differs']);
});

test('live verification rejects restrictive HTTP indexing directives despite matching HTML', async t => {
  const f = fixture(t);
  f.addTranslations(1);
  f.addTranslations(2);
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'], nowMs: Date.parse('2026-09-10T12:00:00Z') });
  for (const directive of ['noindex', 'Googlebot: none', 'nofollow', 'unavailable_after: 01 Jan 2020 00:00:00 GMT']) {
    const report = await verifyLiveLocalizations({
      root: f.directory, origin: 'http://127.0.0.1:4181', args: [],
      fetch: async url => {
        const route = new URL(url).pathname;
        const file = route.endsWith('/') ? `public${route}index.html` : `public${route}`;
        const headers = { 'content-type': route.endsWith('/') ? 'text/html' : 'text/plain' };
        if (route === '/blog/fr/guide-2/') headers['x-robots-tag'] = directive;
        return new Response(f.read(file), { status: 200, headers });
      },
    });
    assert.equal(report.failures.length, 1, directive);
    assert.equal(report.failures[0].route, '/blog/fr/guide-2/');
    assert.equal(report.failures[0].xRobotsTag, directive);
    assert.ok(report.failures[0].issues.some(issue => /Restrictive X-Robots-Tag/.test(issue)));
  }
});

test('live verification rejects changed global and crawler-specific robots policy', async t => {
  const f = fixture(t);
  f.addTranslations(1);
  f.addTranslations(2);
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'], nowMs: Date.parse('2026-09-10T12:00:00Z') });
  for (const policy of [
    'User-agent: *\nDisallow: /\nSitemap: https://norva.tv/sitemap-blog.xml\n',
    'User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /*\nSitemap: https://norva.tv/sitemap-blog.xml\n',
  ]) {
    const report = await verifyLiveLocalizations({
      root: f.directory, origin: 'http://127.0.0.1:4181', args: [],
      fetch: async url => {
        const route = new URL(url).pathname;
        const file = route.endsWith('/') ? `public${route}index.html` : `public${route}`;
        return new Response(route === '/robots.txt' ? policy : f.read(file), {
          status: 200, headers: { 'content-type': route.endsWith('/') ? 'text/html' : 'text/plain' },
        });
      },
    });
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].route, '/robots.txt');
    assert.ok(report.failures[0].issues.some(issue => /robots.txt differs/.test(issue)));
  }
});
