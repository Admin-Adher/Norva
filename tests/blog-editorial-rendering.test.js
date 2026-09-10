const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderMarkdown, renderInline, resolveBlogImage } = require('../scripts/blog/lib/markdown');
const { renderArticlePage } = require('../scripts/blog/lib/templates');
const { splitDocument } = require('../scripts/blog/lib/frontmatter');
const { main } = require('../scripts/blog/build-blog');

const root = path.resolve(__dirname, '..');
test('article images keep a fluid width before lazy-loaded bytes arrive', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/blog.css'), 'utf8');
  const rule = css.match(/\.article-figure img\s*\{([^}]+)\}/)[1];
  assert.match(rule, /(?:^|;)\s*width:\s*100%\s*;/);
  assert.match(rule, /(?:^|;)\s*height:\s*auto\s*;/);
  assert.doesNotMatch(rule, /(?:^|;)\s*width:\s*auto\s*;/);
});

const article = (body, sources = []) => {
  const headings = [];
  return {
    slug: 'editorial-test', title: 'Editorial test', canonicalUrl: 'https://norva.tv/blog/editorial-test/',
    metaDescription: 'A test article.', excerpt: '', cluster: '', publishedAtISO: '2026-07-14T06:00:00+02:00',
    updatedAtISO: '2026-07-14T06:00:00+02:00', displayDate: '14 July 2026', readingMinutes: 4,
    robots: 'index,follow', bodyHtml: renderMarkdown(body, { headings }), headings,
    sources, cta: { href: 'https://norva.tv/#features', label: 'Metadata CTA fallback' }, related: [],
  };
};

test('curated Sources labels and missing metadata references share exactly one section', () => {
  const page = renderArticlePage(article('## Useful answer\n\nAnswer.\n\n## Sources\n\n- [Descriptive primary source](https://norva.tv/terms)\n', [
    'https://norva.tv/terms', 'https://norva.tv/privacy', 'https://norva.tv/privacy', 'javascript:alert(1)',
  ]));
  const body = page.match(/<article\b[\s\S]*?<\/article>/)[0];
  assert.equal((body.match(/<h2[^>]*>Sources<\/h2>/g) || []).length, 1);
  assert.equal((body.match(/href="https:\/\/norva.tv\/terms"/g) || []).length, 1);
  assert.equal((body.match(/href="https:\/\/norva.tv\/privacy"/g) || []).length, 1);
  assert.match(body, />Descriptive primary source<\/a>/);
  assert.doesNotMatch(body, /javascript:/);
});

test('the contextual next step is the one instrumented primary article CTA', () => {
  const page = renderArticlePage(article('## Answer\n\nAnswer.\n\n## Your next step\n\nKeep your own source ready.\n\n[Open the relevant guide](/blog/norva-getting-started/)\n\n## Sources\n\n- [Norva](https://norva.tv/)'));
  assert.equal((page.match(/data-blog-cta="primary"/g) || []).length, 1);
  assert.match(page, /data-blog-article="editorial-test"/);
  assert.match(page, /Keep your own source ready/);
  assert.match(page, /Open the relevant guide/);
  assert.doesNotMatch(page, /Metadata CTA fallback/);
  assert.match(page, /\/js\/marketing\.js\?v=[a-f0-9]{10}/);
});

test('metadata CTA remains available when no contextual body CTA exists', () => {
  const page = renderArticlePage(article('## Answer\n\nAnswer.'));
  assert.equal((page.match(/data-blog-cta="primary"/g) || []).length, 1);
  assert.match(page, /Metadata CTA fallback/);
});

test('all existing published articles render one Sources section and one primary CTA', () => {
  const published = JSON.parse(fs.readFileSync(path.join(root, 'content/blog/published-state.json'))).published;
  const files = fs.readdirSync(path.join(root, 'content/blog/articles')).filter((file) => published[String(Number(file.match(/^\d+/)?.[0]))]);
  assert.equal(files.length, Object.keys(published).length);
  for (const file of files) {
    const { data, body } = splitDocument(fs.readFileSync(path.join(root, 'content/blog/articles', file), 'utf8'));
    const page = renderArticlePage({ ...article(body, data.sources), cta: data.cta, slug: data.slug });
    assert.equal((page.match(/<h2[^>]*>Sources<\/h2>/g) || []).length, 1, `${file}: Sources`);
    assert.equal((page.match(/data-blog-cta="primary"/g) || []).length, 1, `${file}: primary CTA`);
    assert.equal((page.match(/<h1[ >]/g) || []).length, 1, `${file}: H1`);
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-blog-editorial-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('local informative images reserve intrinsic dimensions and escape alt/caption', (t) => {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, 'assets/blog'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'assets/blog/example.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/></svg>');
  const html = renderMarkdown('![A <clear> example](/assets/blog/example.svg "Explanation <not HTML>")', { publicDir: directory });
  assert.match(html, /<figure class="article-figure">/);
  assert.match(html, /width="960" height="540" loading="lazy" decoding="async"/);
  assert.match(html, /alt="A &lt;clear&gt; example"/);
  assert.match(html, /<figcaption>Explanation &lt;not HTML&gt;/);
  assert.match(html, /<a class="article-figure-link" href="\/assets\/blog\/example.svg" target="_blank" rel="noopener">Open full-size image \(new tab\)<\/a><\/figcaption>/);
  assert.doesNotMatch(html, /<svg/);
  const withoutCaption = renderMarkdown('![A clear example](/assets/blog/example.svg)', { publicDir: directory });
  assert.match(withoutCaption, /<figcaption><a class="article-figure-link"/);
  const css = fs.readFileSync(path.join(root, 'public/css/blog.css'), 'utf8');
  assert.match(css, /\.article-figure img\s*\{[^}]*max-width: 100%; width: 100%; height: auto; margin-inline: auto/);
  assert.match(css, /\.article-figure-link\s*\{[^}]*min-height: 44px/);
});

test('image parser rejects missing, external, traversal, active SVG and undimensioned assets', (t) => {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, 'assets/blog'), { recursive: true });
  for (const [name, value] of Object.entries({
    active: '<svg width="10" height="10"><script>alert(1)</script></svg>',
    remote: '<svg width="10" height="10"><image href="https://example.com/a.png"/></svg>',
    invalid: '<svg width="0" height="10"></svg>',
    unknown: '<svg></svg>',
  })) {
    fs.writeFileSync(path.join(directory, `assets/blog/${name}.svg`), value);
    assert.throws(() => resolveBlogImage(`/assets/blog/${name}.svg`, directory));
  }
  for (const url of ['https://example.com/a.png', '/assets/blog/../a.png', '/assets/blog/%2e%2e/a.png', 'data:image/png;base64,abc', '/assets/blog/missing.png']) {
    assert.throws(() => renderMarkdown(`![Example](${url})`, { publicDir: directory }));
  }
  assert.throws(() => renderMarkdown('![](/assets/blog/invalid.svg)', { publicDir: directory }));
});

test('strict SVG profile rejects namespace, CSS, animation and XML parser evasions', (t) => {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, 'assets/blog'), { recursive: true });
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${body}</svg>`;
  const attacks = [
    svg('<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>'),
    svg('<s:foreignObject xmlns:s="http://www.w3.org/2000/svg"><div>HTML</div></s:foreignObject>'),
    svg('<s:image xmlns:s="http://www.w3.org/2000/svg" href="https://example.com/image.png"/>'),
    svg('<s:use xmlns:s="http://www.w3.org/2000/svg" href="#x"/>'),
    svg('<set attributeName="href" to="javascript:alert(1)"/>'),
    svg('<animate attributeName="fill" values="red;blue" dur="1s" repeatCount="indefinite"/>'),
    svg('<style>@im\\70ort "https://example.com/style.css";</style>'),
    svg('<rect style="fill:u\\72l(https://example.com/paint.svg)"/>'),
    svg('<rect fill="u\\72l(https://example.com/paint.svg)"/>'),
    svg('<rect fill="url(&#104;ttps://example.com/paint.svg)"/>'),
    svg('<rect onload="alert(1)"/>'),
    svg('<g xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></g>'),
    svg('<rect xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com"/>'),
    `<?xml-stylesheet href="https://example.com/style.css"?>${svg('')}`,
    `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///private.txt">]>${svg('<text>&xxe;</text>')}`,
    svg('<![CDATA[<script>alert(1)</script>]]>'),
    svg('<rect width="10" width="20"/>'),
    svg('<g><rect></g>'),
    svg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    `${svg('')}${svg('')}`,
  ];
  attacks.forEach((attack, index) => {
    const file = `/assets/blog/attack-${index}.svg`;
    fs.writeFileSync(path.join(directory, file.slice(1)), attack);
    assert.throws(() => resolveBlogImage(file, directory), /Unsafe blog SVG/, `rejected attack ${index}`);
  });
});

test('Markdown keeps HTML inert, suppresses unsafe links, and makes tables keyboard scrollable', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))\n\n| Action | Result |\n| --- | --- |\n| Read | Understand |');
  assert.doesNotMatch(html, /<img|href="javascript:/);
  assert.match(html, /&lt;img/);
  assert.match(html, /class="table-wrap" role="region" aria-label="Scrollable table" tabindex="0"/);
  assert.match(html, /<th scope="col">/);
  assert.match(renderInline('[Safe](/support?mode=a&returnTo=b)'), /href="\/support\?mode=a&amp;returnTo=b"/);
});

function buildFixture(t) {
  const directory = fixture(t);
  const content = path.join(directory, 'content/blog');
  fs.mkdirSync(path.join(content, 'articles'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'public'), { recursive: true });
  fs.writeFileSync(path.join(content, 'publication-calendar.csv'), 'sequence,scheduled_publish_at,content_id,slug,title,cluster\n1,2026-01-01T00:00:00Z,1,existing,Existing,Test\n2,2026-01-02T00:00:00Z,2,newly-due,Newly due,Test\n');
  for (const [id, slug] of [[1, 'existing'], [2, 'newly-due']]) {
    fs.writeFileSync(path.join(content, `articles/${id}-${slug}.md`), `---\ntitle: "${slug}"\nslug: "${slug}"\nmeta_description: "Test."\ncanonical_url: "https://norva.tv/blog/${slug}/"\n---\n# ${slug}\n\n## Answer\n\nRead [existing](/blog/existing/) and [not published](/blog/newly-due/).\n`);
  }
  const state = '{\n  "published": { "1": "2026-02-01T12:34:56Z" }\n}\n';
  fs.writeFileSync(path.join(content, 'published-state.json'), state);
  return { directory, content, state };
}

test('existing-only rebuild is idempotent, freezes publication dates, and cannot add due articles', (t) => {
  const { directory, content, state } = buildFixture(t);
  const calendar = fs.readFileSync(path.join(content, 'publication-calendar.csv'), 'utf8');
  main({ root: directory, args: ['--existing-only'], nowMs: Date.parse('2030-01-01') });
  const output = path.join(directory, 'public/blog/existing/index.html');
  const first = fs.readFileSync(output, 'utf8');
  const paths = [output, path.join(directory, 'public/blog/index.html'), path.join(directory, 'public/sitemap-blog.xml')];
  const snapshots = paths.map((file) => ({ text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs }));
  main({ root: directory, args: ['--existing-only'], nowMs: Date.parse('2031-01-01') });
  paths.forEach((file, index) => {
    assert.equal(fs.readFileSync(file, 'utf8'), snapshots[index].text);
    assert.equal(fs.statSync(file).mtimeMs, snapshots[index].mtime);
  });
  assert.match(first, /2026-02-01T12:34:56Z/);
  assert.doesNotMatch(first, /href="\/blog\/newly-due\/"/);
  assert.equal(fs.existsSync(path.join(directory, 'public/blog/newly-due')), false);
  assert.equal(fs.readFileSync(path.join(content, 'published-state.json'), 'utf8'), state);
  assert.equal(fs.readFileSync(path.join(content, 'publication-calendar.csv'), 'utf8'), calendar);
});

test('existing-only dry run writes nothing and fails closed on missing or invalid state', (t) => {
  const { directory, content, state } = buildFixture(t);
  main({ root: directory, args: ['--existing-only', '--dry-run'] });
  assert.deepEqual(fs.readdirSync(path.join(directory, 'public')), []);
  assert.equal(fs.readFileSync(path.join(content, 'published-state.json'), 'utf8'), state);
  fs.writeFileSync(path.join(content, 'published-state.json'), '{broken');
  assert.throws(() => main({ root: directory, args: ['--existing-only'] }), /Cannot rebuild existing articles/);
  fs.writeFileSync(path.join(content, 'published-state.json'), '{"published":{"999":"2026-01-01"}}');
  assert.throws(() => main({ root: directory, args: ['--existing-only'] }), /unresolved ID/);
  fs.unlinkSync(path.join(content, 'published-state.json'));
  assert.throws(() => main({ root: directory, args: ['--existing-only'] }), /is missing/);
});

test('default scheduled publishing behavior is unchanged', (t) => {
  const { directory, content } = buildFixture(t);
  main({ root: directory, args: [], nowMs: Date.parse('2030-01-01') });
  assert.equal(fs.existsSync(path.join(directory, 'public/blog/newly-due/index.html')), true);
  const state = JSON.parse(fs.readFileSync(path.join(content, 'published-state.json'))).published;
  assert.equal(state['1'], '2026-02-01T12:34:56Z');
  assert.equal(state['2'], '2026-01-02T00:00:00Z');
});
