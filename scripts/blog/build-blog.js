#!/usr/bin/env node
'use strict';

/**
 * Norva blog builder + scheduled auto-publisher.
 *
 * Source of truth:
 *   - content/blog/articles/NNN-*.md         1,000 Markdown drafts
 *   - content/blog/publication-calendar.csv  sequence + scheduled instant per article
 *   - content/blog/published-state.json      first-publication instant per published article
 *
 * On every run it publishes the set of articles whose scheduled slot has passed
 * (a floor of BLOG_MIN_PUBLISHED articles is always live, which is how the first
 * batch goes out before the calendar catches up), renders each to a static page
 * under public/blog/<slug>/index.html, rebuilds public/blog/index.html and
 * public/sitemap-blog.xml, and records the real first-publication instant so
 * dates never drift or get back-dated. It is idempotent: re-running with no new
 * due article changes nothing.
 *
 * The scheduled GitHub Actions workflow (.github/workflows/blog-autopublish.yml)
 * runs this and commits + deploys when the output changes.
 *
 * Local editorial maintenance: --existing-only rebuilds exactly the content IDs
 * already in published-state.json, without adding due articles or writing state.
 * Combine with --dry-run to inspect the frozen set without writing any output.
 */

const fs = require('fs');
const path = require('path');

const { splitDocument } = require('./lib/frontmatter');
const { renderMarkdown } = require('./lib/markdown');
const { renderArticlePage, renderIndexPage, SITE } = require('./lib/templates');
const { formatDisplayDate, estimateReadingMinutes } = require('./lib/format');

const ROOT = path.join(__dirname, '..', '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'blog');
const ARTICLES_DIR = path.join(CONTENT_DIR, 'articles');
const CALENDAR_CSV = path.join(CONTENT_DIR, 'publication-calendar.csv');
const STATE_FILE = path.join(CONTENT_DIR, 'published-state.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BLOG_OUT = path.join(PUBLIC_DIR, 'blog');
const SITEMAP_OUT = path.join(PUBLIC_DIR, 'sitemap-blog.xml');

const MIN_PUBLISHED = parseInt(process.env.BLOG_MIN_PUBLISHED || '4', 10);
const ROBOTS = process.env.BLOG_ROBOTS || 'index,follow';

/* ------------------------------ CSV parsing ------------------------------ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadCalendar(file = CALENDAR_CSV) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  const idx = (name) => header.indexOf(name);
  const iSeq = idx('sequence');
  const iAt = idx('scheduled_publish_at');
  const iId = idx('content_id');
  const iSlug = idx('slug');
  const iTitle = idx('title');
  const iCluster = idx('cluster');
  return rows.slice(1).filter((r) => r[iSeq]).map((r) => ({
    sequence: parseInt(r[iSeq], 10),
    scheduledPublishAt: r[iAt],
    scheduledDate: new Date(r[iAt]),
    contentId: parseInt(r[iId], 10),
    slug: r[iSlug],
    title: r[iTitle],
    cluster: r[iCluster],
  })).sort((a, b) => a.sequence - b.sequence);
}

/* --------------------------- article metadata ---------------------------- */

// Map every content_id (leading number of the filename) to its file path.
function indexArticleFiles(directory = ARTICLES_DIR) {
  const byId = new Map();
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(/^(\d+)-/);
    if (m) byId.set(parseInt(m[1], 10), path.join(directory, name));
  }
  return byId;
}

function loadArticle(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = splitDocument(raw);
  return { data, body };
}

/* ------------------------------- helpers --------------------------------- */

function slugFromBlogUrl(url) {
  let p = url;
  const m = url.match(/^https?:\/\/[^/]*norva\.tv(\/.*)$/i);
  if (m) p = m[1];
  if (!p.startsWith('/blog/')) return null;
  const rest = p.slice('/blog/'.length).split(/[?#]/)[0];
  const seg = rest.split('/').filter(Boolean);
  return seg.length ? seg[0] : ''; // '' means the index
}

function bodyPlainText(body) {
  return body.replace(/[#>*`|_\-]/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/* -------------------------------- build ---------------------------------- */

function main(options = {}) {
  const root = options.root || ROOT;
  const args = options.args || process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const existingOnly = args.includes('--existing-only') || args.includes('--render-published-only');
  for (const arg of args) {
    if (!['--dry-run', '--existing-only', '--render-published-only'].includes(arg)) throw new Error(`Unknown blog build option: ${arg}`);
  }
  const contentDir = path.join(root, 'content/blog');
  const stateFile = path.join(contentDir, 'published-state.json');
  const publicDir = path.join(root, 'public');
  const blogOut = path.join(publicDir, 'blog');
  const sitemapOut = path.join(publicDir, 'sitemap-blog.xml');
  const calendar = loadCalendar(path.join(contentDir, 'publication-calendar.csv'));
  const filesById = indexArticleFiles(path.join(contentDir, 'articles'));
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const nowISO = new Date(nowMs).toISOString();

  // Frozen maintenance mode fails closed when the publication record is absent
  // or malformed; it must never silently fall back to the time-based schedule.
  let state = {};
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).published;
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Missing published map');
    } catch (error) {
      if (existingOnly) throw new Error(`Cannot rebuild existing articles: ${error.message}`);
      state = {};
    }
  } else if (existingOnly) {
    throw new Error('Cannot rebuild existing articles: published-state.json is missing');
  }
  let stateChanged = false;

  // Validate: every calendar entry must resolve to a draft file.
  const missing = calendar.filter((e) => !filesById.has(e.contentId));
  if (missing.length) {
    console.warn(`[blog] WARNING: ${missing.length} calendar entries have no draft file (e.g. content_id ${missing.slice(0, 5).map((m) => m.contentId).join(', ')})`);
  }
  const usable = calendar.filter((e) => filesById.has(e.contentId));

  // Determine how many articles are live: the floor, or everything already due.
  const dueByTime = usable.filter((e) => e.scheduledDate.getTime() <= nowMs).length;
  const scheduledLiveCount = Math.min(usable.length, Math.max(MIN_PUBLISHED, dueByTime));
  const liveEntries = existingOnly
    ? usable.filter((entry) => Object.prototype.hasOwnProperty.call(state, String(entry.contentId)))
    : usable.slice(0, scheduledLiveCount);
  const liveCount = liveEntries.length;
  if (existingOnly) {
    const resolvedIds = new Set(liveEntries.map((entry) => String(entry.contentId)));
    const unresolved = Object.keys(state).filter((id) => !resolvedIds.has(id) || !Number.isFinite(Date.parse(state[id])));
    if (unresolved.length) throw new Error(`Cannot rebuild existing articles: unresolved ID or invalid publication date (${unresolved.join(', ')})`);
  }
  const liveSlugs = new Set();

  // Resolve each live entry's frontmatter slug (authoritative for the URL).
  const loaded = liveEntries.map((entry) => {
    const { data, body } = loadArticle(filesById.get(entry.contentId));
    const slug = (data.slug && String(data.slug).trim()) || entry.slug;
    liveSlugs.add(slug);
    return { entry, data, body, slug };
  });

  // Metadata lookup for related-article cards (title/excerpt/cluster by slug).
  const metaBySlug = new Map();
  for (const { data, slug } of loaded) {
    metaBySlug.set(slug, {
      slug,
      title: data.title || '',
      excerpt: data.excerpt || '',
      cluster: data.topic_cluster || '',
    });
  }

  const rendered = [];
  for (const { entry, data, body, slug } of loaded) {
    const cid = String(entry.contentId);

    // First-publication instant: the planned slot if it has already passed,
    // otherwise the real instant we are publishing early (never back-dated).
    if (!existingOnly && !state[cid]) {
      state[cid] = entry.scheduledDate.getTime() <= nowMs ? entry.scheduledPublishAt : nowISO;
      stateChanged = true;
    }
    const publishedAtISO = state[cid];
    const updatedAtISO = (data.updated_at && String(data.updated_at)) || publishedAtISO;

    const headings = [];
    const ctx = {
      headings,
      publicDir,
      isLinkSuppressed: (url) => {
        const s = slugFromBlogUrl(url);
        if (s === null || s === '') return false; // not a blog article link, or the index
        return !liveSlugs.has(s);
      },
    };
    const bodyHtml = renderMarkdown(body, ctx);

    const related = (Array.isArray(data.related_articles) ? data.related_articles : [])
      .map((href) => slugFromBlogUrl(href))
      .filter((s) => s && liveSlugs.has(s) && s !== slug)
      .map((s) => metaBySlug.get(s))
      .filter(Boolean)
      .slice(0, 3);

    const readingMinutes = Number(data.estimated_reading_minutes) > 0
      ? Number(data.estimated_reading_minutes)
      : estimateReadingMinutes(bodyPlainText(body));

    const article = {
      slug,
      canonicalUrl: (data.canonical_url && String(data.canonical_url)) || `${SITE}/blog/${slug}/`,
      title: data.title || entry.title,
      seoTitle: data.seo_title || data.title || entry.title,
      metaDescription: data.meta_description || data.excerpt || '',
      excerpt: data.excerpt || '',
      cluster: data.topic_cluster || entry.cluster || '',
      bodyHtml,
      headings,
      publishedAtISO,
      updatedAtISO,
      displayDate: formatDisplayDate(publishedAtISO),
      readingMinutes,
      robots: ROBOTS,
      author: data.author || { name: '' },
      cta: data.cta || null,
      sources: Array.isArray(data.sources) ? data.sources : [],
      related,
      schemaType: data.schema_type || 'BlogPosting',
      ogImage: (data.og_image && String(data.og_image)) || (data.hero && data.hero.src) || null,
      sequence: entry.sequence,
    };

    rendered.push(article);
  }

  // Newest first for the index and sitemap.
  const ordered = rendered.slice().sort((a, b) => {
    const d = new Date(b.publishedAtISO) - new Date(a.publishedAtISO);
    return d !== 0 ? d : a.sequence - b.sequence;
  });

  if (dryRun) {
    console.log(existingOnly
      ? `[blog] DRY RUN — ${liveCount} existing article(s); schedule ignored; publication state read-only`
      : `[blog] DRY RUN — ${liveCount} live (floor ${MIN_PUBLISHED}, due-by-time ${dueByTime}) of ${usable.length} scheduled`);
    ordered.forEach((a) => console.log(`  · ${a.slug}  (${a.displayDate}, ${a.readingMinutes}m)`));
    return;
  }

  // Write article pages.
  let written = 0;
  for (const article of rendered) {
    const dir = path.join(blogOut, article.slug);
    fs.mkdirSync(dir, { recursive: true });
    const html = renderArticlePage(article);
    const out = path.join(dir, 'index.html');
    const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (prev !== html) { fs.writeFileSync(out, html); written++; }
  }

  // Write index page.
  fs.mkdirSync(blogOut, { recursive: true });
  writeIfChanged(path.join(blogOut, 'index.html'), renderIndexPage(ordered));

  // Write blog sitemap.
  writeSitemap(ordered, sitemapOut);

  // Persist state.
  if (!existingOnly && stateChanged) {
    fs.writeFileSync(stateFile, `${JSON.stringify({ published: state }, null, 2)}\n`);
  }

  console.log(existingOnly
    ? `[blog] rebuilt ${liveCount} existing article(s); ${written} page(s) written/updated; schedule ignored; publication state unchanged`
    : `[blog] published ${liveCount} article(s) (floor ${MIN_PUBLISHED}, due-by-time ${dueByTime}); ${written} page(s) written/updated; state ${stateChanged ? 'updated' : 'unchanged'}`);
}

function writeIfChanged(file, content) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
}

function writeSitemap(ordered, file = SITEMAP_OUT) {
  const lastmod = (iso) => new Date(iso).toISOString().slice(0, 10);
  const newest = ordered.length ? ordered[0].updatedAtISO : new Date().toISOString();
  const urls = [];
  urls.push(`  <url>
    <loc>${SITE}/blog/</loc>
    <lastmod>${lastmod(newest)}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>`);
  for (const a of ordered) {
    urls.push(`  <url>
    <loc>${a.canonicalUrl}</loc>
    <lastmod>${lastmod(a.updatedAtISO)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
  writeIfChanged(file, xml);
}

if (require.main === module) main();
module.exports = { main };
