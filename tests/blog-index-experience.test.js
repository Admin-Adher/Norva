const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { renderIndexPage } = require('../scripts/blog/lib/templates');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const article = (index, cluster) => ({
  slug: `guide-${index}`,
  canonicalUrl: `https://norva.tv/blog/guide-${index}/`,
  title: `Guide ${index}`,
  metaDescription: `Useful description ${index}`,
  excerpt: `Practical answer ${index}`,
  cluster,
  publishedAtISO: `2026-08-${String(24 - index).padStart(2, '0')}T06:00:00+02:00`,
  displayDate: `${24 - index} August 2026`,
  readingMinutes: 6,
});

test('blog index creates a structured, searchable knowledge library', () => {
  const html = renderIndexPage([
    article(0, 'Caption Accessibility'),
    article(1, 'Account Security'),
    article(2, 'Mobile Viewing Workflows'),
    article(3, 'Buffering Diagnostics'),
    article(4, 'Metadata Quality'),
    article(5, 'Norva Onboarding'),
  ]);

  assert.match(html, /data-blog-index/);
  assert.match(html, /class="hero-feature"/);
  assert.match(html, /id="recent-heading"/);
  assert.match(html, /role="search"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-topic="accessibility"/);
  assert.match(html, /data-topic="privacy"/);
  assert.match(html, /data-topic="anywhere"/);
  assert.match(html, /data-topic="playback"/);
  assert.match(html, /data-topic="organise"/);
  assert.match(html, /data-topic="start"/);
  assert.match(html, /\/js\/blog-index\.js\?v=[0-9a-f]+/);
  assert.doesNotMatch(html, /on(?:click|input|submit)=/i);
});

test('blog index adapter and styles preserve progressive enhancement safeguards', () => {
  const script = read('public/js/blog-index.js');
  const css = read('public/css/blog.css');

  assert.match(script, /if \(!root\) return/);
  assert.match(script, /aria-pressed/);
  assert.match(script, /visibleLimit \+= pageSize/);
  assert.match(script, /event\.key === 'Escape'/);
  assert.match(css, /\.blog-index/);
  assert.match(css, /\.blog-index \[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.topic-chip \{[\s\S]*?min-height: 44px/);
  assert.match(css, /content-visibility: auto/);
  assert.match(css, /body::before \{[\s\S]*?blog-stars-drift/);
  assert.match(css, /@media \(max-width: 980px\) \{[\s\S]*?body::before \{ opacity: \.3; animation: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
});
