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
const TRIAL_HREF = '/account.html?returnTo=%2Fapp%23home';
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
        <a href="/support.html?returnTo=%2Fblog%2F">Support</a>
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

const BLOG_TOPICS = [
  {
    id: 'start',
    label: 'Getting started',
    keywords: ['norva', 'fundamental', 'glossary', 'evaluation', 'subscription', 'account management', 'maintenance'],
  },
  {
    id: 'organise',
    label: 'Organise & discover',
    keywords: ['library', 'catalog', 'collection', 'metadata', 'search', 'filter', 'favorite', 'watchlist', 'recommendation', 'continue watching', 'import', 'category', 'movie', 'series'],
  },
  {
    id: 'anywhere',
    label: 'Watch anywhere',
    keywords: ['cross-device', 'handoff', 'mobile', 'tablet', 'browser', 'tv interface', 'smart tv', 'remote', 'd-pad', 'travel', 'offline', 'live guide', 'tv guide'],
  },
  {
    id: 'playback',
    label: 'Playback & quality',
    keywords: ['playback', 'buffer', 'video quality', 'audio quality', 'network'],
  },
  {
    id: 'accessibility',
    label: 'Audio & accessibility',
    keywords: ['accessibility', 'caption', 'subtitle', 'audio track', 'language', 'visual comfort'],
  },
  {
    id: 'privacy',
    label: 'Privacy & security',
    keywords: ['privacy', 'security', 'household', 'profile', 'governance', 'device security'],
  },
];

function topicForCluster(cluster) {
  const normalised = String(cluster || '').toLowerCase();
  const ordered = [
    BLOG_TOPICS[4],
    BLOG_TOPICS[5],
    BLOG_TOPICS[2],
    BLOG_TOPICS[3],
    BLOG_TOPICS[1],
    BLOG_TOPICS[0],
  ];
  return ordered.find((topic) => topic.keywords.some((keyword) => normalised.includes(keyword))) || BLOG_TOPICS[0];
}

const arrowIcon = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg>`;

function renderLibraryCard(article, index) {
  const topic = topicForCluster(article.cluster);
  const summary = article.excerpt || article.metaDescription;
  return `<article class="library-card" data-library-item data-topic="${escapeAttr(topic.id)}" data-highlighted="${index < 5 ? 'true' : 'false'}">
          <a href="/blog/${escapeAttr(article.slug)}/">
            <div class="library-card-topline">
              <span class="topic-label">${escapeHtml(topic.label)}</span>
              <span class="cluster-label">${escapeHtml(article.cluster || 'Norva guide')}</span>
            </div>
            <h3>${escapeHtml(article.title)}</h3>
            <p>${escapeHtml(summary)}</p>
            <div class="library-card-meta">
              <span><time datetime="${escapeAttr(article.publishedAtISO)}">${escapeHtml(article.displayDate)}</time> · ${article.readingMinutes} min</span>
              ${arrowIcon}
            </div>
          </a>
        </article>`;
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

  const featured = articles[0] || null;
  const recent = articles.slice(1, 5);
  const archiveCount = Math.max(articles.length - 5, 0);

  const featuredStory = featured
    ? `<article class="hero-feature">
        <a href="/blog/${escapeAttr(featured.slug)}/" aria-label="Read the latest guide: ${escapeAttr(featured.title)}">
          <img src="/img/devices/norva-device-tv.webp" width="1280" height="720" alt="Norva media library interface displayed on a television" decoding="async" fetchpriority="high">
          <span class="hero-feature-scrim" aria-hidden="true"></span>
          <div class="hero-feature-copy">
            <div class="hero-feature-labels">
              <span class="latest-label">Latest guide</span>
              ${featured.cluster ? `<span>${escapeHtml(featured.cluster)}</span>` : ''}
            </div>
            <h2>${escapeHtml(featured.title)}</h2>
            <div class="hero-feature-meta"><time datetime="${escapeAttr(featured.publishedAtISO)}">${escapeHtml(featured.displayDate)}</time><span>·</span><span>${featured.readingMinutes} min read</span></div>
          </div>
        </a>
      </article>`
    : '<div class="hero-feature hero-feature-empty"><p>New guides are on the way.</p></div>';

  const recentStories = recent.length
    ? `<section class="recent-section" aria-labelledby="recent-heading">
        <div class="section-heading compact-heading">
          <div><span class="section-number" aria-hidden="true">01</span><h2 id="recent-heading">Recently published</h2></div>
          <p>Fresh field notes from the Norva editorial desk.</p>
        </div>
        <ol class="recent-list">
          ${recent.map((article, index) => `<li>
            <a href="/blog/${escapeAttr(article.slug)}/">
              <span class="recent-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
              <span class="recent-copy">
                <span>${escapeHtml(article.cluster || 'Norva guide')}</span>
                <strong>${escapeHtml(article.title)}</strong>
              </span>
              ${arrowIcon}
            </a>
          </li>`).join('\n          ')}
        </ol>
      </section>`
    : '';

  const topicButtons = BLOG_TOPICS.map((topic) => `<button type="button" class="topic-chip" data-topic-filter="${escapeAttr(topic.id)}" aria-pressed="false">${escapeHtml(topic.label)}</button>`).join('\n              ');

  const library = articles.length
    ? `<section class="library-section" id="library" aria-labelledby="library-heading">
        <div class="section-heading library-heading">
          <div><span class="section-number" aria-hidden="true">02</span><h2 id="library-heading">Explore the full library</h2></div>
          <p>Search by problem, workflow, device or topic.</p>
        </div>
        <form class="library-search" role="search" data-library-search>
          <label for="blog-search">What do you want to solve?</label>
          <div class="search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.7"/></svg>
            <input id="blog-search" type="search" inputmode="search" autocomplete="off" placeholder="Try “subtitles”, “TV”, or “privacy”" aria-describedby="blog-search-hint" data-library-query>
            <button type="button" class="search-clear" aria-label="Clear search" data-library-clear hidden>Clear</button>
          </div>
          <span id="blog-search-hint">Results update as you type. Choose a focus to narrow the library.</span>
        </form>
        <div class="topic-filters" aria-label="Filter guides by focus">
          <button type="button" class="topic-chip is-active" data-topic-filter="all" aria-pressed="true">All guides</button>
          ${topicButtons}
        </div>
        <div class="library-status-row">
          <p class="library-status" role="status" aria-live="polite" data-library-status>${archiveCount} more guide${archiveCount === 1 ? '' : 's'} · newest first</p>
          <button type="button" class="reset-filters" data-library-reset hidden>Reset filters</button>
        </div>
        <div class="library-grid" data-library-grid>
          ${articles.map(renderLibraryCard).join('\n          ')}
        </div>
        <div class="no-results" data-library-empty hidden>
          <h3>No guide matches that search yet.</h3>
          <p>Try a device name, a shorter phrase, or browse all guides.</p>
          <button type="button" data-library-empty-reset>Browse all guides</button>
        </div>
        <button type="button" class="load-more" data-library-more hidden>Show more guides</button>
      </section>`
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
  <script defer src="/js/blog-index.js?v=1"></script>
</head>
<body>
${header()}
  <main id="main-content" class="wide blog-index" data-blog-index data-guide-count="${articles.length}">
    ${breadcrumb(crumbs)}
    <div data-index-highlights>
      <section class="blog-hero" aria-labelledby="blog-title">
        <div class="blog-hero-copy">
          <span class="eyebrow">Norva knowledge library</span>
          <h1 class="page-title" id="blog-title">A practical operating manual for your <span>media library</span></h1>
          <p>${escapeHtml(description)}</p>
          <div class="hero-facts" aria-label="Blog publishing details">
            <span><strong>${articles.length}</strong> published guide${articles.length === 1 ? '' : 's'}</span>
            <span>New every morning and evening</span>
          </div>
          <a class="hero-jump" href="#library">Explore the library ${arrowIcon}</a>
        </div>
        ${featuredStory}
      </section>
      ${recentStories}
    </div>
    ${library}
  </main>
${footer()}
</body>
</html>
`;
}

module.exports = { renderArticlePage, renderIndexPage, SITE };
