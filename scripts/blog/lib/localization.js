'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { splitDocument } = require('./frontmatter');
const { renderMarkdown } = require('./markdown');
const { formatDisplayDate, estimateReadingMinutes } = require('./format');
const LOCALES = require('../../../i18n/locales.json').map(locale => ({
  ...locale,
  // Norva's Filipino UI uses fil (BCP 47); Search requires ISO 639-1.
  hreflang: locale.code === 'fil' ? 'tl' : locale.code,
}));
const SITE = 'https://norva.tv';
const validSlug = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 100;
const hashText = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const localeFor = code => LOCALES.find(locale => locale.code === code);
function blogPath(code = 'en', slug = '') {
  if (!localeFor(code) || (slug && !validSlug(slug))) throw new Error('Invalid localized blog route');
  return `/blog/${code === 'en' ? '' : `${code}/`}${slug ? `${slug}/` : ''}`;
}
function parseBlogUrl(value) {
  try {
    const url = new URL(value, SITE);
    if (url.origin !== SITE || !url.pathname.startsWith('/blog')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'blog') return null;
    let code = 'en';
    if (parts[1] && localeFor(parts[1]) && parts[1] !== 'en') code = parts.splice(1, 1)[0];
    if (parts.length > 2 || (parts[1] && !validSlug(parts[1]))) return null;
    return { code, slug: parts[1] || '', suffix: url.search + url.hash };
  } catch (_) { return null; }
}
function loadUi(contentDir, code) {
  const base = JSON.parse(fs.readFileSync(path.join(contentDir, 'i18n/ui/en.json'), 'utf8'));
  const ui = JSON.parse(fs.readFileSync(path.join(contentDir, `i18n/ui/${code}.json`), 'utf8'));
  const placeholders = text => (text.match(/\{[a-z]+\}/g) || []).sort().join(',');
  if (Object.keys(base).sort().join(',') !== Object.keys(ui).sort().join(',')) throw new Error(`Incomplete blog UI dictionary: ${code}`);
  for (const key of Object.keys(base)) {
    if (typeof ui[key] !== 'string' || !ui[key].trim() || placeholders(ui[key]) !== placeholders(base[key])) throw new Error(`Invalid blog UI translation: ${code}.${key}`);
  }
  return ui;
}
function alternates(slug, codes) {
  if (codes.length < 2) return [];
  return [...LOCALES.filter(locale => codes.includes(locale.code)).map(locale => ({
    ...locale, href: `${SITE}${blogPath(locale.code, slug)}`,
  })), { code: 'x-default', hreflang: 'x-default', href: `${SITE}${blogPath('en', slug)}` }];
}

function checkStructure(source, translated, key) {
  const headings = body => [...body.matchAll(/^(#{1,6})\s+.+$/gm)].map(match => match[1].length);
  const targets = body => [...body.matchAll(/!?\[[^\]]*\]\(([^\s)]+)/g)].map(match => match[1]).sort();
  const images = body => [...body.matchAll(/^!\[[^\]]+\]\(([^\s)]+)/gm)].map(match => match[1]);
  const listCount = body => (body.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  const tableRows = body => (body.match(/^\|.+\|\s*$/gm) || []).length;
  if (JSON.stringify(headings(source)) !== JSON.stringify(headings(translated))) throw new Error(`Translation heading structure differs: ${key}`);
  if (JSON.stringify(targets(source)) !== JSON.stringify(targets(translated))) throw new Error(`Translation link destinations differ: ${key}`);
  if (JSON.stringify(images(source)) !== JSON.stringify(images(translated))) throw new Error(`Translation evidence images differ: ${key}`);
  if (listCount(source) !== listCount(translated) || tableRows(source) !== tableRows(translated)) throw new Error(`Translation list/table structure differs: ${key}`);
  if (translated.includes('\uFFFD') || /\u0000/.test(translated)) throw new Error(`Invalid translation Unicode: ${key}`);
}

/** A preview can share the local output tree, but must never survive a release. */
function assertNoUnreleasedTranslationPages(publicDir, state) {
  const expected = new Set();
  for (const key of Object.keys(state.published)) {
    const [code, slug, extra] = key.split('/');
    if (extra || code === 'en' || !localeFor(code) || !validSlug(slug)) throw new Error(`Invalid translation publication key: ${key}`);
    expected.add(`blog/${code}/${slug}/index.html`);
    expected.add(`blog/${code}/index.html`);
  }
  const actual = [];
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(publicDir, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in translation output: ${relative}`);
      if (entry.isDirectory()) inspect(file);
      else if (/\.html$/i.test(entry.name)) {
        if (!expected.has(relative)) throw new Error(`Unreleased translation output remains: ${relative}. Use a clean release checkout; no file was deleted.`);
        actual.push(relative);
      }
    }
  }
  for (const locale of LOCALES.filter(item => item.code !== 'en')) {
    const folder = path.join(publicDir, 'blog', locale.code);
    if (fs.existsSync(folder)) {
      if (fs.lstatSync(folder).isSymbolicLink()) throw new Error(`Unexpected translation output symlink: ${locale.code}`);
      inspect(folder);
    }
  }
  return { expected: [...expected], actual };
}

/** No calendar-driven translation release: reviewed bytes and source must match. */
function loadTranslations({ contentDir, loaded, preview = false, publish = false, nowISO }) {
  const directory = path.join(contentDir, 'translations');
  const stateFile = path.join(directory, 'published-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { published: {} };
  if (!state.published || typeof state.published !== 'object' || Array.isArray(state.published)) throw new Error('Invalid translation publication state');
  const reviewsFile = path.join(directory, 'reviewed.json');
  const reviews = fs.existsSync(reviewsFile) ? JSON.parse(fs.readFileSync(reviewsFile, 'utf8')) : { articles: {} };
  const sources = new Map(loaded.map(article => [article.slug, article]));
  const translations = [];
  const seen = new Set();
  let stateChanged = false;
  if (!fs.existsSync(directory)) return { translations, state, stateFile, stateChanged };
  const sourceUiHash = hashText(fs.readFileSync(path.join(contentDir, 'i18n/ui/en.json'), 'utf8'));
  for (const locale of LOCALES.filter(item => item.code !== 'en')) {
    const folder = path.join(directory, locale.code);
    if (!fs.existsSync(folder)) continue;
    const ui = loadUi(contentDir, locale.code);
    const uiHash = hashText(fs.readFileSync(path.join(contentDir, `i18n/ui/${locale.code}.json`), 'utf8'));
    const uiReview = reviews.ui?.[locale.code];
    const uiReviewed = reviews.source_ui_sha256 === sourceUiHash && uiReview?.source_sha256 === sourceUiHash
      && uiReview.sha256 === uiHash && uiReview.decision === 'approved' && uiReview.method === 'ai_assisted_cross_review';
    for (const filename of fs.readdirSync(folder).filter(name => name.endsWith('.md')).sort()) {
      const raw = fs.readFileSync(path.join(folder, filename), 'utf8');
      const { data, body } = splitDocument(raw);
      const key = `${locale.code}/${data.source_slug}`;
      if (seen.has(key)) throw new Error(`Duplicate translation: ${key}`);
      seen.add(key);
      if (data.language !== locale.code || !validSlug(data.source_slug)) throw new Error(`Invalid translation identity: ${filename}`);
      const source = sources.get(data.source_slug);
      if (!source) throw new Error(`Translation source is not published: ${key}`);
      if (data.source_sha256 !== source.sourceHash) throw new Error(`Stale translation source: ${key}`);
      checkStructure(source.body, body, key);
      for (const field of ['title', 'seo_title', 'meta_description', 'excerpt', 'topic_cluster']) {
        if (typeof data[field] !== 'string' || !data[field].trim()) throw new Error(`Missing translation ${field}: ${key}`);
      }
      if (data.sources_heading !== ui.sources || data.next_step_heading !== ui.nextStep) throw new Error(`Editorial heading mismatch: ${key}`);
      if (!['in_review', 'approved', 'published'].includes(data.translation_status) || data.translation_method !== 'ai_assisted') throw new Error(`Invalid translation review status: ${key}`);
      const translationHash = hashText(raw);
      const review = reviews.articles?.[key];
      const reviewMatches = review && review.source_sha256 === source.sourceHash && review.translation_sha256 === translationHash
        && review.method === 'ai_assisted_cross_review' && review.decision === 'approved'
        && reviews.owner_release_authorized === true && uiReviewed;
      const released = state.published[key];
      const changed = released && (released.source_sha256 !== source.sourceHash || released.translation_sha256 !== translationHash);
      if (released && !Number.isFinite(Date.parse(released.published_at))) throw new Error(`Invalid translation publication date: ${key}`);
      if (!preview && released && ((!publish && changed) || !reviewMatches || data.translation_status === 'in_review')) throw new Error(`Published translation requires a new reviewed release: ${key}`);
      if (publish && (!released || changed)) {
        if (!reviewMatches || data.translation_status === 'in_review') throw new Error(`Translation is not approved for release: ${key}`);
        state.published[key] = { published_at: released?.published_at || nowISO, updated_at: nowISO, source_sha256: source.sourceHash, translation_sha256: translationHash };
        stateChanged = true;
      }
      if (!preview && !state.published[key]) continue;
      translations.push({ key, locale, ui, data, body, source, publishedAtISO: state.published[key]?.published_at || nowISO,
        updatedAtISO: state.published[key]?.updated_at || state.published[key]?.published_at || nowISO, preview: preview || !state.published[key] });
    }
  }
  for (const key of Object.keys(state.published)) if (!seen.has(key)) throw new Error(`Published translation is missing: ${key}`);
  return { translations, state, stateFile, stateChanged };
}

function localizeArticles({ english, translations, publicDir }) {
  const bySlug = new Map(english.map(article => [article.slug, article]));
  const variants = new Map();
  for (const entry of translations) {
    const { locale, data, ui, source } = entry;
    const original = bySlug.get(source.slug);
    const article = {
      ...original, locale, ui, title: data.title, seoTitle: data.seo_title, metaDescription: data.meta_description,
      excerpt: data.excerpt, cluster: data.topic_cluster, canonicalUrl: `${SITE}${blogPath(locale.code, source.slug)}`,
      publishedAtISO: entry.publishedAtISO, updatedAtISO: entry.updatedAtISO,
      displayDate: formatDisplayDate(entry.publishedAtISO, 'Europe/Paris', locale.code),
      originalPublishedDate: formatDisplayDate(original.publishedAtISO, 'Europe/Paris', locale.code),
      originalUrl: original.canonicalUrl, robots: entry.preview ? 'noindex,nofollow' : original.robots,
      preview: entry.preview, translated: true, bodySource: entry.body, related: [],
      readingMinutes: estimateReadingMinutes(entry.body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*`|_\-]/g, ' ')),
      sourcesHeading: data.sources_heading, nextStepHeading: data.next_step_heading,
      // Authored next-step copy is translated; never append an English fallback.
      cta: null,
    };
    variants.set(entry.key, article);
  }
  for (const article of variants.values()) {
    const code = article.locale.code;
    const localizedLink = value => {
      const parsed = parseBlogUrl(value);
      if (!parsed) return { href: value };
      if (!parsed.slug) return { href: blogPath(code) + parsed.suffix };
      const target = variants.get(`${code}/${parsed.slug}`);
      if (target) {
        // Preserve English section anchors through positional aliases generated
        // from the unchanged source, even when the displayed heading is translated.
        return { href: blogPath(code, parsed.slug) + parsed.suffix };
      }
      return { href: blogPath('en', parsed.slug) + parsed.suffix, language: 'en', note: article.ui.englishLink };
    };
    const original = bySlug.get(article.slug);
    article.headings = [];
    article.bodyHtml = renderMarkdown(article.bodySource, {
      headings: article.headings, publicDir, ui: article.ui,
      headingAliases: original.headings.map(heading => heading.id),
      sourcesHeading: article.sourcesHeading,
      resolveLink: localizedLink,
      isLinkSuppressed: value => {
        const parsed = parseBlogUrl(value);
        return parsed?.slug ? !bySlug.has(parsed.slug) : false;
      },
    });
    article.related = original.related.map(related => {
      const target = variants.get(`${code}/${related.slug}`);
      return target ? { ...target, href: blogPath(code, related.slug) } : { ...related, href: blogPath('en', related.slug), language: 'en', note: article.ui.englishLink };
    });
  }
  const all = [...english, ...variants.values()];
  for (const article of all) {
    const codes = all.filter(other => other.slug === article.slug && !other.preview).map(other => other.locale?.code || 'en');
    article.alternates = article.preview ? [] : alternates(article.slug, codes);
    // Preview navigation is useful but must not leak into production alternates.
    article.languageLinks = alternates(article.slug, all.filter(other => other.slug === article.slug).map(other => other.locale?.code || 'en'));
  }
  return [...variants.values()];
}

module.exports = { LOCALES, localeFor, blogPath, parseBlogUrl, hashText, loadUi, alternates, checkStructure, loadTranslations, localizeArticles, assertNoUnreleasedTranslationPages };
