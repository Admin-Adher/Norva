'use strict';

/**
 * HTML templates for the Norva blog: the article page and the blog index.
 * Both are self-contained static documents styled by /css/blog.css and match
 * the landing site's dark identity, header, and footer conventions.
 */

const { escapeHtml, escapeAttr, jsonLd } = require('./format');
const { isSafeLink } = require('./markdown');
const { blogPath, localeFor } = require('./localization');
const EN_UI = require('../../../content/blog/i18n/ui/en.json');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const i18nAsset = asset => '/' + asset + '?v=' + crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../../../public',asset),'utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,10);
const SITE = 'https://norva.tv';
const CSS_HREF = i18nAsset('css/blog.css');
const DEFAULT_OG = `${SITE}/img/devices/norva-device-tv.webp`;
const LOGO = `${SITE}/img/norva-app-icon-96.png`;
const TRIAL_HREF = '/account.html?returnTo=%2Fapp%23home';
const BYLINE = 'Norva Editorial Team';

const commonHead = ({ title, description, canonical, robots, ogType, ogImage, jsonLdBlocks, alternates = [] }) => `  <meta charset="UTF-8">
  <script defer src="${i18nAsset('js/i18n.js')}"></script>
  <link rel="stylesheet" href="${i18nAsset('css/i18n.css')}">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#05080f">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <link rel="canonical" href="${escapeAttr(canonical)}">
${alternates.map(item => `  <link rel="alternate" hreflang="${escapeAttr(item.hreflang)}" href="${escapeAttr(item.href)}">`).join('\n')}
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
  <script defer src="${i18nAsset('js/marketing.js')}"></script>
  <script defer src="/js/consent-banner.js?v=1"></script>`;

function languagePicker(items = [], ui = EN_UI, language = 'en', isArticle = false) {
  const links = items.filter(item => item.code !== 'x-default');
  if (links.length < 2) return '';
  return `<details class="blog-language-picker"><summary>${escapeHtml(ui.language)}: <bdi>${escapeHtml(localeFor(language).name)}</bdi></summary>
    <nav aria-label="${escapeAttr(isArticle ? ui.articleLanguage : ui.blogLanguage)}"><ul>${links.map(item => `<li><a href="${escapeAttr(new URL(item.href).pathname)}" lang="${escapeAttr(item.code)}" dir="${item.dir}" hreflang="${escapeAttr(item.hreflang)}"${item.code === language ? ' aria-current="page"' : ''}>${escapeHtml(item.name)}</a></li>`).join('')}</ul></nav></details>`;
}

// Static copy is authoritative for an article URL, including without JavaScript.
function localizedChrome(html, ui = EN_UI, language = 'en') {
  const labels = {
    'Skip to content': ui.skip, 'Norva home': ui.norvaHome, Primary: ui.primaryNav,
    'How it works': ui.howItWorks, 'Start free trial': ui.startTrial, Footer: ui.footerNav,
    Home: ui.home, Blog: ui.blog, Benefits: ui.benefits, Pricing: ui.pricing, Support: ui.support,
    Terms: ui.terms, Privacy: ui.privacy, 'Legal notice': ui.legal,
  };
  return html.replace(/ data-i18n(?:-[a-z-]+)?="[^"]*"/g, '')
    .replace(/>([^<>]+)</g, (match, label) => labels[label] ? `>${escapeHtml(labels[label])}<` : match)
    .replace(/aria-label="([^"]+)"/g, (match, label) => labels[label] ? `aria-label="${escapeAttr(labels[label])}"` : match)
    .replace(/href="\/blog\/"/g, `href="${blogPath(language)}"`)
    .replace('href="/support.html?returnTo=%2Fblog%2F"', `href="/support.html?returnTo=${encodeURIComponent(blogPath(language))}"`)
    .replace(/Norva is a media player and organiser\. It does not provide media\. Use requires a compatible source you own or are authorised to access\./g, escapeHtml(ui.disclaimer));
}

const header = () => `  <a class="skip-link" href="#main-content" data-i18n="ui_web_ac576a66d456">Skip to content</a>
  <header class="blog-nav">
    <a class="brand" href="/" aria-label="Norva home" data-i18n-aria-label="ui_web_1a123bf0fced">
      <img src="/img/norva-app-icon-96.png" width="34" height="34" alt="" decoding="async">
      <span>Norva</span>
    </a>
    <nav class="nav-right" aria-label="Primary" data-i18n-aria-label="ui_web_efe10c80ec8a">
      <a href="/blog/" data-i18n="ui_web_8c6bc099534a">Blog</a>
      <a class="hide-sm" href="/#how-it-works" data-i18n="ui_web_9c870aa6e5e9">How it works</a>
      <a class="cta" href="${TRIAL_HREF}" data-cta="blog-nav" data-auth-action data-i18n="ui_web_b1effd1ffed3">Start free trial</a>
    </nav>
  </header>`;

const footer = () => `  <footer class="blog-footer">
    <div class="foot-inner">
      <nav class="foot-links" aria-label="Footer" data-i18n-aria-label="ui_web_26c87bb51e69">
        <a href="/" data-i18n="ui_web_3a78695388b3">Home</a>
        <a href="/blog/" data-i18n="ui_web_8c6bc099534a">Blog</a>
        <a href="/#features" data-i18n="ui_web_d5b67bc930cd">Benefits</a>
        <a href="/#pricing" data-i18n="ui_web_dfe95783edfe">Pricing</a>
        <a href="/support.html?returnTo=%2Fblog%2F" data-i18n="ui_web_be91940b79f4">Support</a>
        <a href="/terms.html" data-i18n="ui_web_ede548996483">Terms</a>
        <a href="/privacy.html" data-i18n="ui_web_54a57c3147c4">Privacy</a>
        <a href="/mentions-legales.html" data-i18n="ui_web_1011b3a811f0">Legal notice</a>
      </nav>
      <p class="disclaimer">&copy; 2026 Norva. Norva is a media player and organiser. It does not provide media. Use requires a compatible source you own or are authorised to access.</p>
    </div>
  </footer>`;

function breadcrumb(items, ui = EN_UI) {
  const parts = items.map((it, idx) => {
    const last = idx === items.length - 1;
    if (last) return `<span aria-current="page">${escapeHtml(it.name)}</span>`;
    return `<a href="${escapeAttr(it.url)}">${escapeHtml(it.name)}</a>`;
  });
  return `<nav class="breadcrumb" aria-label="${escapeAttr(ui.breadcrumb)}">${parts.join('<span class="sep" aria-hidden="true">›</span>')}</nav>`;
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

/** Merge the body's curated references with metadata without two Sources blocks. */
function articleEditorialSections(a) {
  const ui = a.ui || EN_UI;
  const regexLiteral = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = a.bodyHtml || '';
  const sourceBodies = [];
  const sourcePattern = new RegExp(`<h2\\b[^>]*>${regexLiteral(escapeHtml(a.sourcesHeading || 'Sources'))}<\\/h2>\\s*([\\s\\S]*?)(?=<h[12]\\b|$)`, 'gi');
  body = body.replace(sourcePattern, (_, content) => {
    sourceBodies.push(content.trim());
    return '';
  });
  const curated = sourceBodies.join('\n');
  const linked = new Set(Array.from(curated.matchAll(/<a\b[^>]*href="([^"]+)"/g), (m) => m[1]));
  const missing = [];
  for (const source of a.sources || []) {
    if (!isSafeLink(source) || linked.has(escapeAttr(source))) continue;
    linked.add(escapeAttr(source));
    missing.push(source);
  }
  const extra = missing.length
    ? `<ul>${missing.map((url) => `<li><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></li>`).join('')}</ul>`
    : '';
  const sources = curated || extra
    ? `<section class="sources" aria-labelledby="sources"><h2 id="sources">${escapeHtml(ui.sources)}</h2>\n${curated}\n${extra}</section>`
    : '';

  // The authored next-step block is authoritative; never append its CTA twice.
  let primaryFound = false;
  const primaryAttrs = `data-cta="blog-article" data-blog-cta="primary" data-blog-slug="${escapeAttr(a.slug)}"`;
  const nextStepPattern = new RegExp(`(<h2\\b[^>]*>${a.nextStepHeading ? regexLiteral(escapeHtml(a.nextStepHeading)) : '(?:Your )?Next steps?'}<\\/h2>)([\\s\\S]*?)(?=<h[12]\\b|$)`, 'gi');
  body = body.replace(nextStepPattern, (section, heading, content) => {
    if (primaryFound) return section;
    const instrumented = content.replace(/<a\b([^>]*href="[^"]+"[^>]*)>/, (_, attrs) => {
      primaryFound = true;
      return `<a ${attrs} ${primaryAttrs}>`;
    });
    return primaryFound ? `<section class="article-cta">${heading}${instrumented}</section>` : section;
  });
  const cta = !primaryFound && a.cta && isSafeLink(a.cta.href) && a.cta.label
    ? `<section class="article-cta"><a class="btn" href="${escapeAttr(a.cta.href)}" ${primaryAttrs}>${escapeHtml(a.cta.label)}</a></section>`
    : '';
  return { body, sources, cta };
}

/** Render a single article page. */
function renderArticlePage(a) {
  const ui = a.ui || EN_UI;
  const locale = a.locale || localeFor('en');
  const hubPath = blogPath(locale.code);
  const pageTitle = a.seoTitle || a.title;
  const documentTitle = `${pageTitle} | Norva Blog`;

  const crumbs = [
    { name: ui.home, url: '/', absolute: `${SITE}/` },
    { name: ui.blog, url: hubPath, absolute: `${SITE}${hubPath}` },
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
    inLanguage: locale.code,
    ...(a.translated ? { translationOfWork: { '@type': 'BlogPosting', '@id': a.originalUrl, inLanguage: 'en' } } : {}),
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
    ? `<nav class="toc" aria-label="${escapeAttr(ui.onThisPage)}">
      <strong>${escapeHtml(ui.onThisPage)}</strong>
      <ul>${h2s.map((h) => `<li><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`).join('')}</ul>
    </nav>`
    : '';

  const lede = a.excerpt ? `<p class="lede">${escapeHtml(a.excerpt)}</p>` : '';

  const related = (a.related && a.related.length)
    ? `<section class="related">
      <h2>${escapeHtml(ui.related)}</h2>
      <div class="related-grid">
        ${a.related.map((r) => `<a class="card" href="${escapeAttr(r.href || blogPath('en', r.slug))}"${r.language ? ` hreflang="${escapeAttr(r.language)}" lang="${escapeAttr(r.language)}"` : ''}>
          ${r.cluster ? `<span class="tag">${escapeHtml(r.cluster)}</span>` : ''}
          <div class="card-title">${escapeHtml(r.title)}</div>
          ${r.note ? `<span class="link-language" lang="${locale.code}">${escapeHtml(r.note)}</span>` : ''}
          ${r.excerpt ? `<p>${escapeHtml(r.excerpt)}</p>` : ''}
        </a>`).join('\n        ')}
      </div>
    </section>`
    : '';

  const { body, sources, cta } = articleEditorialSections(a);

  return `<!DOCTYPE html>
<html lang="${locale.code}" dir="${locale.dir}" data-norva-document-language="${locale.code}">
<head>
${commonHead({
    title: documentTitle,
    description: a.metaDescription,
    canonical: a.canonicalUrl,
    robots: a.robots,
    ogType: 'article',
    ogImage: a.ogImage,
    jsonLdBlocks: [blogPosting, breadcrumbJsonLd(crumbs)],
    alternates: a.alternates,
  })}
  <script defer src="${i18nAsset('js/blog-language.js')}"></script>
</head>
<body>
${localizedChrome(header(), ui, locale.code)}
  <main id="main-content">
    ${breadcrumb(crumbs, ui)}
    ${languagePicker(a.languageLinks, ui, locale.code, true)}
    <article lang="${locale.code}" dir="${locale.dir}" data-blog-article="${escapeAttr(a.slug)}" data-blog-language="${locale.code}">
      <div class="article-meta">
        ${a.cluster ? `<span class="tag">${escapeHtml(a.cluster)}</span>` : ''}
        <span>${escapeHtml(ui.by)} ${escapeHtml(a.author && a.author.name ? a.author.name : ui.byline)}</span>
        <span class="dot">·</span>
        <time datetime="${escapeAttr(a.publishedAtISO)}">${escapeHtml(a.displayDate)}</time>
        <span class="dot">·</span>
        <span>${escapeHtml(ui.readingTime.replace('{minutes}', String(a.readingMinutes)))}</span>
      </div>
      <h1>${escapeHtml(a.title)}</h1>
      ${lede}
      ${a.translated ? `<aside class="translation-note"><a href="${escapeAttr(a.originalUrl)}" hreflang="en">${escapeHtml(ui.translatedFrom)}</a><span>${escapeHtml(ui.sourcePublished.replace('{date}', a.originalPublishedDate))}</span><p>${escapeHtml(ui.originalImages)}</p></aside>` : ''}
      ${toc}
      ${body}${cta ? '\n      ' + cta : ''}
      ${sources}
      ${related}
    </article>
  </main>
${localizedChrome(footer(), ui, locale.code)}
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

const topicUiKeys = { start: 'hubStart', organise: 'hubOrganise', anywhere: 'hubAnywhere', playback: 'hubPlayback', accessibility: 'hubAccessibility', privacy: 'hubPrivacy' };

function renderLibraryCard(article, index, ui, code) {
  // Classification is inherited from the English source, never guessed from a translation.
  const topic = topicForCluster(article.topicCluster || article.cluster);
  const summary = article.excerpt || article.metaDescription;
  return `<article class="library-card" data-library-item data-topic="${escapeAttr(topic.id)}" data-highlighted="${index < 5 ? 'true' : 'false'}">
          <a href="${blogPath(code, article.slug)}">
            <div class="library-card-topline">
              <span class="topic-label">${escapeHtml(ui[topicUiKeys[topic.id]])}</span>
              <span class="cluster-label">${escapeHtml(article.cluster || ui.hubFallbackTopic)}</span>
            </div>
            <h3>${escapeHtml(article.title)}</h3>
            <p>${escapeHtml(summary)}</p>
            <div class="library-card-meta">
              <span><time datetime="${escapeAttr(article.publishedAtISO)}">${escapeHtml(article.displayDate)}</time> · ${escapeHtml(ui.readingTime.replace('{minutes}', String(article.readingMinutes)))}</span>
              ${arrowIcon}
            </div>
          </a>
        </article>`;
}

/** One editorial layout for every language; only copy, routes and available articles vary. */
function renderIndexPage(articles, options = {}) {
  const locale = options.locale || localeFor('en');
  const ui = options.ui || EN_UI;
  const code = locale.code;
  const canonical = `${SITE}${blogPath(code)}`;
  const description = ui.hubDescription;
  articles = articles.slice().sort((a, b) => (new Date(b.publishedAtISO) - new Date(a.publishedAtISO)) || (a.sequence || 0) - (b.sequence || 0));
  const number = value => new Intl.NumberFormat(code).format(value);
  const heading = escapeHtml(ui.hubTitle).replace('{accent}', `<span>${escapeHtml(ui.hubTitleAccent)}</span>`);

  const crumbs = [
    { name: ui.home, url: '/', absolute: `${SITE}/` },
    { name: ui.blog, url: blogPath(code), absolute: canonical },
  ];

  const blogJsonLd = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `Norva ${ui.blog}`,
    url: canonical,
    inLanguage: code,
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

  const featuredStory = featured
    ? `<article class="hero-feature">
          <a href="${blogPath(code, featured.slug)}" aria-label="${escapeAttr(ui.hubReadLatest.replace('{title}', featured.title))}">
          <img src="/img/devices/norva-device-tv.webp" width="1280" height="720" alt="${escapeAttr(ui.hubImageAlt)}" decoding="async" fetchpriority="high">
          <span class="hero-feature-scrim" aria-hidden="true"></span>
          <div class="hero-feature-copy">
            <div class="hero-feature-labels">
              <span class="latest-label">${escapeHtml(ui.hubLatest)}</span>
              ${featured.cluster ? `<span>${escapeHtml(featured.cluster)}</span>` : ''}
            </div>
            <h2>${escapeHtml(featured.title)}</h2>
            <div class="hero-feature-meta"><time datetime="${escapeAttr(featured.publishedAtISO)}">${escapeHtml(featured.displayDate)}</time><span>·</span><span>${escapeHtml(ui.readingTime.replace('{minutes}', String(featured.readingMinutes)))}</span></div>
          </div>
        </a>
      </article>`
    : `<div class="hero-feature hero-feature-empty"><p>${escapeHtml(ui.hubEmpty)}</p></div>`;

  const recentStories = recent.length
    ? `<section class="recent-section" aria-labelledby="recent-heading">
        <div class="section-heading compact-heading">
          <div><span class="section-number" aria-hidden="true">01</span><h2 id="recent-heading">${escapeHtml(ui.hubRecent)}</h2></div>
          <p>${escapeHtml(ui.hubRecentDescription)}</p>
        </div>
        <ol class="recent-list">
          ${recent.map((article, index) => `<li>
            <a href="${blogPath(code, article.slug)}">
              <span class="recent-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
              <span class="recent-copy">
                <span>${escapeHtml(article.cluster || ui.hubFallbackTopic)}</span>
                <strong>${escapeHtml(article.title)}</strong>
              </span>
              ${arrowIcon}
            </a>
          </li>`).join('\n          ')}
        </ol>
      </section>`
    : '';

  const availableTopics = new Set(articles.map(article => topicForCluster(article.topicCluster || article.cluster).id));
  const topicButtons = BLOG_TOPICS.filter(topic => availableTopics.has(topic.id))
    .map(topic => `<button type="button" class="topic-chip" data-topic-filter="${escapeAttr(topic.id)}" aria-pressed="false">${escapeHtml(ui[topicUiKeys[topic.id]])}</button>`).join('\n              ');
  const translationNotice = code === 'en' ? '' : `<p class="translation-note">${escapeHtml(ui.libraryNotice.replace('{count}', number(articles.length)))} <a href="/blog/" hreflang="en">${escapeHtml(ui.browseEnglish)}</a></p>`;

  const library = articles.length
    ? `<section class="library-section" id="library" aria-labelledby="library-heading">
        <div class="section-heading library-heading">
          <div><span class="section-number" aria-hidden="true">02</span><h2 id="library-heading">${escapeHtml(ui.hubLibrary)}</h2></div>
          <p>${escapeHtml(ui.hubLibraryDescription)}</p>
        </div>
        ${translationNotice}
        <form class="library-search" role="search" data-library-search>
          <label for="blog-search">${escapeHtml(ui.hubSearchLabel)}</label>
          <div class="search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.7"/></svg>
            <input id="blog-search" type="search" inputmode="search" autocomplete="off" placeholder="${escapeAttr(ui.hubSearchPlaceholder)}" aria-describedby="blog-search-hint" data-library-query>
            <button type="button" class="search-clear" aria-label="${escapeAttr(ui.hubClearLabel)}" data-library-clear hidden>${escapeHtml(ui.hubClear)}</button>
          </div>
          <span id="blog-search-hint">${escapeHtml(ui.hubSearchHint)}</span>
        </form>
        <div class="topic-filters" role="group" aria-label="${escapeAttr(ui.hubFilterLabel)}">
          <button type="button" class="topic-chip is-active" data-topic-filter="all" aria-pressed="true">${escapeHtml(ui.hubAll)}</button>
          ${topicButtons}
        </div>
        <div class="library-status-row">
          <p class="library-status" role="status" aria-live="polite" data-library-status>${escapeHtml(ui.hubCount.replace('{count}', number(articles.length)))}</p>
          <button type="button" class="reset-filters" data-library-reset hidden>${escapeHtml(ui.hubReset)}</button>
        </div>
        <div class="library-grid" data-library-grid>
          ${articles.map((article, index) => renderLibraryCard(article, index, ui, code)).join('\n          ')}
        </div>
        <div class="no-results" data-library-empty hidden>
          <h3>${escapeHtml(ui.hubNoResults)}</h3>
          <p>${escapeHtml(ui.hubNoResultsHint)}</p>
          <button type="button" data-library-empty-reset>${escapeHtml(ui.hubBrowseAll)}</button>
        </div>
        <button type="button" class="load-more" data-library-more hidden>${escapeHtml(ui.hubMore)}</button>
      </section>`
    : `<p class="empty">${escapeHtml(ui.hubEmpty)}</p>`;

  return `<!DOCTYPE html>
<html lang="${code}" dir="${locale.dir}" data-norva-document-language="${code}">
<head>
${commonHead({
    title: code === 'en' ? 'Norva Blog — Media library guides & how-tos' : `${ui.libraryTitle} | Norva Blog`,
    description,
    canonical,
    robots: options.preview ? 'noindex,nofollow' : 'index,follow',
    ogType: 'website',
    ogImage: null,
    jsonLdBlocks: [blogJsonLd, breadcrumbJsonLd(crumbs)],
    alternates: options.alternates,
  })}
  <script defer src="${i18nAsset('js/blog-index.js')}"></script>
  <script defer src="${i18nAsset('js/blog-language.js')}"></script>
</head>
<body>
${localizedChrome(header(), ui, code)}
  <main id="main-content" class="wide blog-index" data-blog-index data-blog-language="${code}" data-guide-count="${articles.length}" data-status-results="${escapeAttr(ui.hubResults)}" data-status-remaining="${escapeAttr(ui.hubRemaining)}">
    ${breadcrumb(crumbs, ui)}
    ${languagePicker(options.languageLinks, ui, code)}
    <div data-index-highlights>
      <section class="blog-hero" aria-labelledby="blog-title">
        <div class="blog-hero-copy">
          <span class="eyebrow">${escapeHtml(ui.libraryEyebrow)}</span>
          <h1 class="page-title" id="blog-title">${heading}</h1>
          <p>${escapeHtml(description)}</p>
          <div class="hero-facts">
            <span>${escapeHtml(ui.hubCount).replace('{count}', `<strong>${number(articles.length)}</strong>`)}</span>
            <span>${escapeHtml(ui.hubCadence)}</span>
          </div>
          <a class="hero-jump" href="#library">${escapeHtml(ui.hubExplore)} ${arrowIcon}</a>
        </div>
        ${featuredStory}
      </section>
      ${recentStories}
    </div>
    ${library}
  </main>
${localizedChrome(footer(), ui, code)}
</body>
</html>
`;
}

function renderLocalizedIndexPage(articles, options) {
  return renderIndexPage(articles, options);
}

module.exports = { renderArticlePage, renderIndexPage, renderLocalizedIndexPage, SITE };
