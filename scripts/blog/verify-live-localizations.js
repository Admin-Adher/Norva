#!/usr/bin/env node
'use strict';
// Public read-only verification. No account, provider, Google, or browser tokens.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const extract = (html, regex) => html.match(regex)?.[1] || '';

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  return value;
}

function comparePageHtml(html, expected) {
  const issues = [];
  for (const [label, pattern] of [
    ['title', /<title>([\s\S]*?)<\/title>/], ['H1', /<h1\b[^>]*>([\s\S]*?)<\/h1>/],
    ['description', /<meta name="description" content="([^"]*)"/],
    ['canonical', /<link rel="canonical" href="([^"]+)"/], ['robots', /<meta name="robots" content="([^"]+)"/],
    ['language', /<html\b[^>]*\blang="([^"]+)"/], ['direction', /<html\b[^>]*\bdir="([^"]+)"/],
  ]) if (extract(html, pattern) !== extract(expected, pattern)) issues.push(`${label} differs`);
  if (digest(Buffer.from(extract(html, /(<main\b[\s\S]*?<\/main>)/))) !== digest(Buffer.from(extract(expected, /(<main\b[\s\S]*?<\/main>)/)))) issues.push('Rendered main content differs');
  const alternateTags = source => (source.match(/<link rel="alternate"[^>]+>/g) || []).sort().join('\n');
  if (alternateTags(html) !== alternateTags(expected)) issues.push('hreflang set differs');
  try {
    const jsonLd = source => [...source.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
    // These live head fields are outside <main>. A content hash alone cannot
    // prove datePublished, dateModified, inLanguage or translationOfWork.
    if (JSON.stringify(stableJson(jsonLd(html))) !== JSON.stringify(stableJson(jsonLd(expected)))) {
      issues.push('JSON-LD differs (including publication/modification dates)');
    }
  } catch (error) { issues.push(`Invalid JSON-LD: ${error.message}`); }
  return issues;
}

async function verifyLiveLocalizations(options = {}) {
  const root = options.root || path.resolve(__dirname, '../..');
  const publicDir = path.join(root, 'public');
  const args = options.args || process.argv.slice(2);
  const origin = options.origin || args.find(arg => arg.startsWith('--origin='))?.slice(9) || 'https://norva.tv';
  if (!['https://norva.tv', 'http://127.0.0.1:4181'].includes(origin)) throw new Error('Use the official site or this local preview');
  const output = options.output || args.find(arg => arg.startsWith('--output='))?.slice(9);
  const request = options.fetch || fetch;
  const localSitemap = read(path.join(publicDir, 'sitemap-blog.xml'));
  const routes = [...localSitemap.matchAll(/<loc>https:\/\/norva\.tv([^<]+)<\/loc>/g)].map(match => match[1]);
  const images = new Set();
  const tasks = routes.map(route => ({ route, type: 'page' }));
  for (const route of routes) {
    const html = read(path.join(publicDir, route, 'index.html'));
    for (const match of html.matchAll(/<img\b[^>]*src="(\/assets\/blog\/[^"?#]+)"/g)) images.add(match[1]);
  }
  tasks.push(...[...images].map(route => ({ route, type: 'asset' })), { route: '/sitemap-blog.xml', type: 'sitemap' }, { route: '/robots.txt', type: 'robots' });
  const results = [];
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        const response = await request(origin + task.route, { signal: AbortSignal.timeout(25000), redirect: 'follow' });
        const bytes = Buffer.from(await response.arrayBuffer());
        const html = bytes.toString('utf8').replace(/\r\n/g, '\n');
        const issues = [];
        if (response.status !== 200) issues.push(`HTTP ${response.status}`);
        if (task.type === 'asset') {
          if (digest(bytes) !== digest(fs.readFileSync(path.join(publicDir, task.route)))) issues.push('Asset hash mismatch');
          if (!response.headers.get('content-type')?.startsWith('image/')) issues.push('Not an image response');
        } else if (task.type === 'page') {
          const expected = read(path.join(publicDir, task.route, 'index.html'));
          issues.push(...comparePageHtml(html, expected));
          if (!response.headers.get('content-type')?.includes('text/html')) issues.push('Not an HTML response');
          // An HTTP directive can override index,follow in the reviewed HTML.
          // Agent-scoped or expiry directives need review too; do not certify
          // discovery from the document alone when the response restricts it.
          const headerRobots = response.headers.get('x-robots-tag') || '';
          if (/\b(?:noindex|nofollow|none|unavailable_after)\b/i.test(headerRobots)) {
            issues.push('Restrictive X-Robots-Tag header requires review');
          }
        } else if (task.type === 'sitemap') {
          if (html !== localSitemap) issues.push('Sitemap differs');
        } else {
          // Compare the complete reviewed policy, rather than overlooking a
          // global or user-agent-specific block with a /blog-only regex.
          if (html !== read(path.join(publicDir, 'robots.txt'))) issues.push('robots.txt differs from the reviewed policy');
          if (!html.includes('Sitemap: https://norva.tv/sitemap-blog.xml') || /Disallow:\s*\/blog/.test(html)) issues.push('Blog discovery blocked or sitemap missing');
        }
        results.push({ ...task, status: response.status, cache: response.headers.get('cf-cache-status'),
          xRobotsTag: response.headers.get('x-robots-tag'), bytes: bytes.length, issues });
      } catch (error) { results.push({ ...task, issues: [error.message] }); }
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));
  const report = { checkedAt: new Date().toISOString(), origin, publicPages: routes.length, evidenceImages: images.size,
    checks: results.length, failures: results.filter(result => result.issues.length), results };
  if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (require.main === module) {
  verifyLiveLocalizations().then(report => {
    console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { comparePageHtml, verifyLiveLocalizations };
