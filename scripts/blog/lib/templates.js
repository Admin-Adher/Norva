'use strict';

/**
 * HTML templates for the Norva blog: the article page and the blog index.
 * Both are self-contained static documents styled by /css/blog.css and match
 * the landing site's dark identity, header, and footer conventions.
 */

const { escapeHtml, escapeAttr, jsonLd } = require('./format');

const SITE = 'https://norva.tv';
const CSS_HREF = '/css/blog.css?v=1'; // hash:assets rewrites ?v= to a content hash at deploy
const DEFAULT_OG = `${SITE}/img/devices/norva-device-tv.webp`;
const LOGO = `${SITE}/img/norva-app-icon-96.png`;
const TRIAL_HREF = '/account.html?returnTo=%2Fsubscribe.html%3Fplan%3Dplus%26period%3Dmonthly';
const BYLINE = 'Norva Editorial Team';

const commonHead = ({ title, description, canonical, robots, ogType, ogImage, jsonLdBlocks }) => `  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#05080f">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <link rel="canonical" href="${escapeAttr(canonical)}">
  <meta name="robots" content="${escapeAttr(robots)}">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/outfit-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="${CSS_HREF}">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="Norva">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:url" content="${escapeAttr(canonical)}">
  <meta property="og:image" content="${escapeAttr(ogImage || DEFAULT_OG)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${escapeAttr(ogImage || DEFAULT_OG)}">
${jsonLdBlocks.map((b) => `  <script type="application/ld+json">\n${b}\n  </script>`).join('\n')}
  <script src="/js/marketing-config.js?v=1"></script>
  <script defer src="/js/marketing.js?v=1"></script>
  <script defer src="/js/consent-banner.js?v=1"></script>`;

const header = () => `  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="blog-nav">
    <a class="brand" href="/" aria-label="Norva home">
      <img src="/img/norva-app-icon-96.png" width="34" height="34" alt="" decoding="async">
      <span>Norva</span>
    </a>
    <nav class="nav-right" aria-label="Primary">
      <a href="/blog/">Blog</a>
      <a class="hide-sm" href="/#how-it-works">How it works</a>
      <a class="cta" href="${TRIAL_HREF}" data-cta="blog-nav" data-auth-action>Start free trial</a>
    </nav>
  </header>`;

const footer = () => `  <footer class="blog-footer">
    <div class="foot-inner">
      <nav class="foot-links" aria-label="Footer">
        <a href="/">Home</a>
        <a href="/blog/">Blog</a>
        <a href="/#features">Benefits</a>
        <a href="/#pricing">Pricing</a>
        <a href="/support.html">Support</a>
        <a href="/terms.html">Terms</a>
        <a href="/privacy.html">Privacy</a>
        <a href="/mentions-legales.html">Legal notice</a>
      </nav>
      <p class="disclaimer">&copy; 2026 Norva. Norva is a media player and organiser. It does not provide media. Use requires a compatible source you own or are authorised to access.</p>
    </div>
  </footer>`;

function breadcrumb(items) {
  const parts = items.map((it, idx) => {
    const last = idx === items.length - 1;
    if (last) return `<span aria-current="page">${escapeHtml(it.name)}</span>`;
    return `<a href="${escapeAttr(it.url)}">${escapeHtml(it.name)}</a>`;
  });
  return `<nav class="breadcrumb" aria-label="Breadcrumb">${parts.join('<span class="sep">›</span>')}</nav>`;
}

function breadcrumbJsonLd(items) {
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: it.name,
      item: it.absolute,
    })),
  });
}

/** Render a single article page. */
function renderArticlePage(a) {
  const pageTitle = a.seoTitle || a.title;
  const documentTitle = `${pageTitle} | Norva Blog`;

  const crumbs = [
    { name: 'Home', url: '/', absolute: `${SITE}/` },
    { name: 'Blog', url: '/blog/', absolute: `${SITE}/blog/` },
    { name: a.title, url: a.canonicalUrl, absolute: a.canonicalUrl },
  ];

  const authorNode = a.author && a.author.name
    ? { '@type': 'Person', name: a.author.name, ...(a.author.profileUrl ? { url: a.author.profileUrl } : {}) }
    : { '@type': 'Organization', name: 'Norva' };

  const blogPosting = jsonLd({
    '@context': 'https://schema.org',
    '@type': a.schemaType || 'BlogPosting',
    headline: a.title,
    description: a.metaDescription,
    inLanguage: 'en',
    datePublished: a.publishedAtISO,
    dateModified: a.updatedAtISO || a.publishedAtISO,
    author: authorNode,
    publisher: {
      '@type': 'Organization',
      name: 'Norva',
      logo: { '@type': 'ImageObject', url: LOGO },
    },
    image: [a.ogImage || DEFAULT_OG],
    mainEntityOfPage: { '@type': 'WebPage', '@id': a.canonicalUrl },
  });

  // Table of contents from H2 headings (only when the article is long enough).
  const h2s = (a.headings || []).filter((h) => h.level === 2);
  const toc = h2s.length >= 3
    ? `<nav class="toc" aria-label="On this page">
      <strong>On this page</strong>
      <ul>${h2s.map((h) => `<li><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`).join('')}</ul>
    </nav>`
    : '';

  const lede = a.excerpt ? `<p class="lede">${escapeHtml(a.excerpt)}</p>` : '';

  const related = (a.related && a.related.length)
    ? `<section class="related">
      <h2>Related reading</h2>
      <div class="related-grid">
        ${a.related.map((r) => `<a class="card" href="/blog/${escapeAttr(r.slug)}/">
          ${r.cluster ? `<span class="tag">${escapeHtml(r.cluster)}</span>` : ''}
          <div class="card-title">${escapeHtml(r.title)}</div>
          ${r.excerpt ? `<p>${escapeHtml(r.excerpt)}</p>` : ''}
        </a>`).join('\n        ')}
      </div>
    </section>`
    : '';

  const sources = (a.sources && a.sources.length)
    ? `<section class="sources">
      <h2>Sources</h2>
      <ul>${a.sources.map((s) => `<li><a href="${escapeAttr(s)}" target="_blank" rel="noopener">${escapeHtml(s)}</a></li>`).join('')}</ul>
    </section>`
    : '';

  const cta = (a.cta && a.cta.href && a.cta.label)
    ? `<section class="article-cta">
      <a class="btn" href="${escapeAttr(a.cta.href)}" data-cta="blog-article">${escapeHtml(a.cta.label)}</a>
    </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
${commonHead({
    title: documentTitle,
    description: a.metaDescription,
    canonical: a.canonicalUrl,
    robots: a.robots,
    ogType: 'article',
    ogImage: a.ogImage,
    jsonLdBlocks: [blogPosting, breadcrumbJsonLd(crumbs)],
  })}
</head>
<body>
${header()}
  <main id="main-content">
    ${breadcrumb(crumbs)}
    <article>
      <div class="article-meta">
        ${a.cluster ? `<span class="tag">${escapeHtml(a.cluster)}</span>` : ''}
        <span>By ${escapeHtml(a.author && a.author.name ? a.author.name : BYLINE)}</span>
        <span class="dot">·</span>
        <time datetime="${escapeAttr(a.publishedAtISO)}">${escapeHtml(a.displayDate)}</time>
        <span class="dot">·</span>
        <span>${a.readingMinutes} min read</span>
      </div>
      <h1>${escapeHtml(a.title)}</h1>
      ${lede}
      ${toc}
      ${a.bodyHtml}
      ${cta}
      ${sources}
      ${related}
    </article>
  </main>
${footer()}
</body>
</html>
`;
}

/** Render the blog index page listing published articles (newest first). */
function renderIndexPage(articles) {
  const canonical = `${SITE}/blog/`;
  const description = 'Practical guides on organising a personal media library, playback, cross-device setup, and getting the most out of Norva.';

  const crumbs = [
    { name: 'Home', url: '/', absolute: `${SITE}/` },
    { name: 'Blog', url: '/blog/', absolute: `${SITE}/blog/` },
  ];

  const blogJsonLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Norva Blog',
    url: canonical,
    inLanguage: 'en',
    description,
    publisher: {
      '@type': 'Organization',
      name: 'Norva',
      logo: { '@type': 'ImageObject', url: LOGO },
    },
    blogPost: articles.slice(0, 25).map((a) => ({
      '@type': 'BlogPosting',
      headline: a.title,
      url: a.canonicalUrl,
      datePublished: a.publishedAtISO,
      description: a.metaDescription,
    })),
  });

  const cards = articles.length
    ? `<div class="post-grid">
      ${articles.map((a) => `<a class="card post-card" href="/blog/${escapeAttr(a.slug)}/">
        ${a.cluster ? `<span class="tag">${escapeHtml(a.cluster)}</span>` : ''}
        <div class="card-title">${escapeHtml(a.title)}</div>
        <p>${escapeHtml(a.excerpt || a.metaDescription)}</p>
        <div class="card-meta"><time datetime="${escapeAttr(a.publishedAtISO)}">${escapeHtml(a.displayDate)}</time> · ${a.readingMinutes} min read</div>
      </a>`).join('\n      ')}
    </div>`
    : '<p class="empty">Articles are on the way. Check back soon.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
${commonHead({
    title: 'Norva Blog — Media library guides & how-tos',
    description,
    canonical,
    robots: 'index,follow',
    ogType: 'website',
    ogImage: null,
    jsonLdBlocks: [blogJsonLd, breadcrumbJsonLd(crumbs)],
  })}
</head>
<body>
${header()}
  <main id="main-content" class="wide">
    ${breadcrumb(crumbs)}
    <div class="blog-hero">
      <span class="eyebrow">Norva Blog</span>
      <h1 class="page-title">Guides for a calmer, better-organised media library</h1>
      <p>${escapeHtml(description)}</p>
    </div>
    ${cards}
  </main>
${footer()}
</body>
</html>
`;
}

module.exports = { renderArticlePage, renderIndexPage, SITE };
