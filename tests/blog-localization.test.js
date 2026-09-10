const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { main } = require('../scripts/blog/build-blog');
const { LOCALES, blogPath, parseBlogUrl, hashText, loadUi, checkStructure, assertNoUnreleasedTranslationPages } = require('../scripts/blog/lib/localization');
const { renderMarkdown } = require('../scripts/blog/lib/markdown');
const { slugifyHeading, formatDisplayDate } = require('../scripts/blog/lib/format');
const EN = require('../content/blog/i18n/ui/en.json');
const root = path.resolve(__dirname, '..');

test('keyboard skip link stays within both LTR and RTL scroll bounds', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/blog.css'), 'utf8');
  const rule = css.match(/\.skip-link\s*\{([^}]+)\}/)[1];
  assert.match(rule, /inset-inline-start:\s*0/);
  assert.match(rule, /clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(rule, /-9999/);
  assert.match(css, /\.skip-link:focus\s*\{[^}]*clip-path:\s*none/);
  // A 320 CSS-pixel viewport can have a narrower client area with a scrollbar.
  assert.match(css, /\bbody\s*\{[^}]*min-width:\s*0/);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-blog-i18n-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const content = path.join(directory, 'content/blog');
  const write = (file, data) => { const target = path.join(directory, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); };
  write('public/.fixture', '');
  write('content/blog/publication-calendar.csv', 'sequence,scheduled_publish_at,content_id,slug,title,cluster\n1,2026-01-01T00:00:00Z,1,existing,Existing,Test\n2,2026-01-02T00:00:00Z,2,english-only,English only,Test\n');
  write('content/blog/published-state.json', JSON.stringify({ published: { '1': '2026-02-01T12:00:00Z', '2': '2026-02-02T12:00:00Z' } }));
  write('content/blog/i18n/ui/en.json', JSON.stringify(EN));
  const body = '# Test\n\n## Answer\n\nA concrete example. [Other](/blog/english-only/) and [self](/blog/existing/#answer).\n\n## Your next step\n\n[Open Norva](/app#home)\n\n## Sources\n\n- [Primary](https://norva.tv/)\n';
  const original = '---\ntitle: "Existing"\nslug: "existing"\nmeta_description: "A test"\n---\n' + body;
  write('content/blog/articles/001-existing.md', original);
  write('content/blog/articles/002-english-only.md', original.replace('slug: "existing"', 'slug: "english-only"'));
  for (const language of ['fr', 'ar']) {
    const ui = { ...EN, sources: language === 'fr' ? 'Sources documentaires' : 'المصادر', nextStep: language === 'fr' ? 'Prochaine étape' : 'الخطوة التالية', onThisPage: language === 'fr' ? 'Sur cette page' : 'في هذه الصفحة' };
    write(`content/blog/i18n/ui/${language}.json`, JSON.stringify(ui));
    const metadata = { language, source_slug: 'existing', source_sha256: hashText(original), title: `${language} titre`,
      seo_title: `${language} SEO`, meta_description: `${language} description`, excerpt: `${language} résumé`, topic_cluster: `${language} thème`,
      sources_heading: ui.sources, next_step_heading: ui.nextStep, translation_status: 'in_review', translation_method: 'ai_assisted' };
    const translated = '---\n' + Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n'
      + body.replace('## Answer', language === 'ar' ? '## إجابة مفيدة' : '## Réponse utile').replace('## Your next step', `## ${ui.nextStep}`).replace('## Sources', `## ${ui.sources}`);
    write(`content/blog/translations/${language}/001-existing.md`, translated);
  }
  const read = file => fs.readFileSync(path.join(directory, file), 'utf8');
  const approve = () => {
    const articles = {}, ui = {};
    const sourceUiHash = hashText(read('content/blog/i18n/ui/en.json'));
    for (const language of ['fr', 'ar']) {
      const file = `content/blog/translations/${language}/001-existing.md`;
      const raw = read(file).replace('translation_status: "in_review"', 'translation_status: "approved"');
      write(file, raw);
      articles[`${language}/existing`] = { source_sha256: hashText(original), translation_sha256: hashText(raw), method: 'ai_assisted_cross_review', decision: 'approved' };
      ui[language] = { source_sha256: sourceUiHash, sha256: hashText(read(`content/blog/i18n/ui/${language}.json`)), method: 'ai_assisted_cross_review', decision: 'approved' };
    }
    write('content/blog/translations/reviewed.json', JSON.stringify({ owner_release_authorized: true, source_ui_sha256: sourceUiHash, articles, ui }));
  };
  return { directory, content, write, read, approve };
}

test('ten routes reuse the app locale registry, keeping English stable and Filipino ISO SEO alias explicit', () => {
  assert.equal(LOCALES.length, 10);
  assert.equal(blogPath('en', 'test'), '/blog/test/');
  assert.equal(blogPath('pt-BR', 'test'), '/blog/pt-BR/test/');
  assert.equal(LOCALES.find(locale => locale.code === 'fil').hreflang, 'tl');
  assert.equal(LOCALES.find(locale => locale.code === 'ar').dir, 'rtl');
  assert.throws(() => blogPath('de', 'test'), /Invalid/);
  assert.throws(() => blogPath('fr', '../private'), /Invalid/);
  assert.deepEqual(parseBlogUrl('/blog/fr/existing/?a=b#answer'), { code: 'fr', slug: 'existing', suffix: '?a=b#answer' });
  for (const url of ['https://evilnorva.tv/blog/test/', 'https://norva.tv.evil.test/blog/test/', '/blogevil/test/', '/blog/fr/test/extra/', 'javascript:alert(1)']) assert.equal(parseBlogUrl(url), null, url);
});

test('Unicode headings are non-empty, unique, and English deep links are stable across a translation', () => {
  for (const heading of ['إجابة مفيدة', 'उपयोगी उत्तर', 'দরকারি উত্তর', 'Une réponse']) assert.ok(slugifyHeading(heading).length > 0);
  const headings = [];
  const html = renderMarkdown('## إجابة\n\n## إجابة\n\n## !', { headings });
  assert.equal(new Set(headings.map(heading => heading.id)).size, 3);
  assert.doesNotMatch(html, /id=""/);
  assert.match(renderMarkdown('## Réponse', { headingAliases: ['answer'] }), /id="answer"/);
  assert.match(formatDisplayDate('2026-09-10T12:00:00Z', 'Europe/Paris', 'fr'), /septembre/);
});

test('UI placeholders and complete structural evidence must survive translation', t => {
  const { directory, content, write } = fixture(t);
  assert.equal(loadUi(content, 'ar').sources, 'المصادر');
  write('content/blog/i18n/ui/ar.json', JSON.stringify({ ...EN, readingTime: 'No placeholder' }));
  assert.throws(() => loadUi(content, 'ar'), /readingTime/);
  const body = '# Source\n## Answer\n[Link](/app)\n- One\n';
  assert.doesNotThrow(() => checkStructure(body, body.replace('Answer', 'Réponse').replace('One', 'Un'), 'fr/test'));
  for (const variant of [body.replace('## Answer', '### Answer'), body.replace('/app', '/other'), body.replace('- One', 'One')]) assert.throws(() => checkStructure(body, variant, 'fr/test'), /differ/);
  assert.ok(directory);
});

test('unreviewed translations never join the live build, sitemap or reciprocal alternates', t => {
  const f = fixture(t);
  main({ root: f.directory, args: ['--existing-only'] });
  assert.doesNotMatch(f.read('public/blog/existing/index.html'), /hreflang="fr"/);
  assert.doesNotMatch(f.read('public/sitemap-blog.xml'), /\/blog\/fr\//);
  assert.equal(fs.existsSync(path.join(f.directory, 'public/blog/fr')), false);
  assert.throws(() => main({ root: f.directory, args: ['--existing-only', '--publish-translations'] }), /not approved/);
});

test('preview is fully rendered and noindex with unchanged source dates/state and no sitemap leakage', t => {
  const f = fixture(t), state = f.read('content/blog/published-state.json');
  main({ root: f.directory, args: ['--existing-only', '--preview-translations'], nowMs: Date.parse('2026-09-10T15:00:00Z') });
  const html = f.read('public/blog/ar/existing/index.html');
  assert.match(html, /<html lang="ar" dir="rtl" data-norva-document-language="ar">/);
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /href="\/blog\/ar\/existing\/#answer"/);
  assert.match(html, /href="\/support\.html\?returnTo=%2Fblog%2Far%2F"/);
  assert.match(f.read('public/blog/fr/existing/index.html'), /href="\/support\.html\?returnTo=%2Fblog%2Ffr%2F"/);
  assert.match(html, /href="\/blog\/english-only\/" hreflang="en"/);
  assert.match(html, /id="answer">إجابة مفيدة/);
  assert.match(html, /"inLanguage": "ar"/);
  assert.equal((html.match(/data-blog-cta="primary"/g) || []).length, 1);
  assert.equal((html.match(/id="sources"/g) || []).length, 1);
  assert.match(html, /id="sources">المصادر/);
  assert.match(html, /"datePublished": "2026-09-10T15:00:00.000Z"/);
  assert.doesNotMatch(html, /<link rel="alternate"/);
  assert.doesNotMatch(f.read('public/sitemap-blog.xml'), /\/blog\/(ar|fr)\//);
  assert.equal(f.read('content/blog/published-state.json'), state);
  assert.equal(fs.existsSync(path.join(f.content, 'translations/published-state.json')), false);
  assert.throws(() => main({ root: f.directory, args: ['--existing-only'] }), /Unreleased translation output remains/);
  assert.equal(f.read('public/blog/ar/existing/index.html'), html, 'a rejected release never silently deletes a preview');
});

test('every translated output and hub must belong to a reviewed release, including outside the first selection', t => {
  const f = fixture(t); f.approve();
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'] });
  const state = JSON.parse(f.read('content/blog/translations/published-state.json'));
  assert.equal(assertNoUnreleasedTranslationPages(path.join(f.directory, 'public'), state).actual.length, 4);
  f.write('public/blog/fr/unreviewed-extra/index.html', '<h1>Draft</h1>');
  assert.throws(() => assertNoUnreleasedTranslationPages(path.join(f.directory, 'public'), state), /unreviewed-extra/);
  assert.throws(() => main({ root: f.directory, args: ['--existing-only'] }), /Unreleased translation output remains/);
  assert.throws(() => assertNoUnreleasedTranslationPages(path.join(f.directory, 'public'), { published: { 'fr/../outside': {} } }), /Invalid translation publication key/);
});

test('reviewed release creates self canonicals, identical reciprocal alternates, real dates, and is idempotent', t => {
  const f = fixture(t); f.approve();
  const sourceState = f.read('content/blog/published-state.json');
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'], nowMs: Date.parse('2026-09-10T15:00:00Z') });
  const alternateSets = [];
  for (const code of ['en', 'fr', 'ar']) {
    const html = f.read(`public${blogPath(code, 'existing')}index.html`);
    assert.match(html, new RegExp(`rel="canonical" href="https://norva.tv${blogPath(code, 'existing')}"`));
    assert.match(html, /name="robots" content="index,follow"/);
    alternateSets.push(html.match(/<link rel="alternate"[^>]+>/g));
  }
  assert.equal(alternateSets[0].length, 4);
  assert.deepEqual(alternateSets[0], alternateSets[1]);
  assert.deepEqual(alternateSets[1], alternateSets[2]);
  const html = f.read('public/blog/fr/existing/index.html');
  const published = f.read('content/blog/translations/published-state.json');
  main({ root: f.directory, args: ['--existing-only'], nowMs: Date.parse('2035-01-01') });
  assert.equal(f.read('content/blog/translations/published-state.json'), published);
  assert.equal(f.read('public/blog/fr/existing/index.html'), html);
  assert.equal(f.read('content/blog/published-state.json'), sourceState);
  assert.equal((f.read('public/sitemap-blog.xml').match(/<loc>/g) || []).length, 7);
  f.write('content/blog/translations/fr/001-existing.md', f.read('content/blog/translations/fr/001-existing.md') + '\nUnreviewed change.\n');
  assert.throws(() => main({ root: f.directory, args: ['--existing-only'] }), /requires a new reviewed release/);
  main({ root: f.directory, args: ['--existing-only', '--preview-translations'] });
  assert.match(f.read('public/blog/fr/existing/index.html'), /name="robots" content="noindex,nofollow"/);
  assert.match(f.read('public/blog/fr/existing/index.html'), /Unreviewed change/);
  assert.equal(f.read('content/blog/translations/published-state.json'), published, 'previewing a revision cannot alter a released timestamp/hash');
});

test('source edits and incomplete reviewed states stop stale translations before rendering', t => {
  const f = fixture(t); f.approve();
  f.write('content/blog/articles/001-existing.md', f.read('content/blog/articles/001-existing.md') + '\nChanged fact.\n');
  assert.throws(() => main({ root: f.directory, args: ['--existing-only', '--publish-translations'] }), /Stale translation source/);
});

test('unreviewed source or translated UI changes cannot alter a released disclaimer or navigation', t => {
  const f = fixture(t); f.approve();
  main({ root: f.directory, args: ['--existing-only', '--publish-translations'] });
  const originalUi = f.read('content/blog/i18n/ui/fr.json');
  f.write('content/blog/i18n/ui/fr.json', JSON.stringify({ ...JSON.parse(originalUi), disclaimer: 'Unreviewed replacement' }));
  assert.throws(() => main({ root: f.directory, args: ['--existing-only'] }), /requires a new reviewed release/);
  f.write('content/blog/i18n/ui/fr.json', originalUi);
  const english = JSON.parse(f.read('content/blog/i18n/ui/en.json'));
  f.write('content/blog/i18n/ui/en.json', JSON.stringify({ ...english, disclaimer: 'Changed source position' }));
  assert.throws(() => main({ root: f.directory, args: ['--existing-only', '--publish-translations'] }), /requires a new reviewed release/);
});

test('onward locale handoff uses the existing API only on a deliberate same-origin product link', () => {
  const script = fs.readFileSync(path.join(root, 'public/js/blog-language.js'), 'utf8');
  const calls = [], listeners = {};
  const context = {
    document: { documentElement: { getAttribute: () => 'ar' }, addEventListener: (key, callback) => { listeners[key] = callback; } },
    location: { pathname: '/blog/ar/test/', href: 'https://norva.tv/blog/ar/test/', origin: 'https://norva.tv' },
    window: { NorvaI18n: { setPreference: code => calls.push(code) } }, URL,
  };
  vm.runInNewContext(script, context);
  assert.deepEqual(calls, [], 'reading the article saves nothing');
  const click = (href, extra = {}) => listeners.click({ target: { closest: () => ({ getAttribute: () => href }) }, ...extra });
  for (const url of ['https://evil.test/app', '/blog/fr/test/', '/assets/blog/proof.jpg', 'javascript:alert(1)', 'https://user:pass@norva.tv/app']) click(url);
  click('/app#home', { defaultPrevented: true });
  assert.deepEqual(calls, []);
  click('/account.html?returnTo=%2Fapp%23home');
  assert.deepEqual(calls, ['ar']);
});

test('Escape closes the language picker and returns focus without changing the app language', () => {
  const script = fs.readFileSync(path.join(root, 'public/js/blog-language.js'), 'utf8');
  const listeners = {};
  let focused = 0;
  const picker = { open: true, querySelector: () => ({ focus: () => { focused++; } }) };
  vm.runInNewContext(script, {
    document: { documentElement: { getAttribute: () => 'ar' },
      addEventListener: (key, callback) => { listeners[key] = callback; },
      querySelectorAll: selector => selector === '.blog-language-picker[open]' && picker.open ? [picker] : [] },
    location: { pathname: '/blog/ar/test/' }, window: {}, URL,
  });
  listeners.keydown({ key: 'Enter' });
  assert.equal(picker.open, true);
  listeners.keydown({ key: 'Escape' });
  assert.equal(picker.open, false);
  assert.equal(focused, 1);
  listeners.keydown({ key: 'Escape' });
  assert.equal(focused, 1);
});
