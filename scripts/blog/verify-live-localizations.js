#!/usr/bin/env node
'use strict';
// Public read-only verification. No account, provider, Google, or browser tokens.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const origin = process.argv.find(arg => arg.startsWith('--origin='))?.slice(9) || 'https://norva.tv';
if (!['https://norva.tv', 'http://127.0.0.1:4181'].includes(origin)) throw new Error('Use the official site or this local preview');
const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const extract = (html, regex) => html.match(regex)?.[1] || '';
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
      const response = await fetch(origin + task.route, { signal: AbortSignal.timeout(25000), redirect: 'follow' });
      const bytes = Buffer.from(await response.arrayBuffer());
      const html = bytes.toString('utf8').replace(/\r\n/g, '\n');
      const issues = [];
      if (response.status !== 200) issues.push(`HTTP ${response.status}`);
      if (task.type === 'asset') {
        if (digest(bytes) !== digest(fs.readFileSync(path.join(publicDir, task.route)))) issues.push('Asset hash mismatch');
        if (!response.headers.get('content-type')?.startsWith('image/')) issues.push('Not an image response');
      } else if (task.type === 'page') {
        const expected = read(path.join(publicDir, task.route, 'index.html'));
        for (const [label, pattern] of [
          ['title', /<title>([\s\S]*?)<\/title>/], ['H1', /<h1\b[^>]*>([\s\S]*?)<\/h1>/],
          ['canonical', /<link rel="canonical" href="([^"]+)"/], ['robots', /<meta name="robots" content="([^"]+)"/],
          ['language', /<html\b[^>]*\blang="([^"]+)"/], ['direction', /<html\b[^>]*\bdir="([^"]+)"/],
        ]) if (extract(html, pattern) !== extract(expected, pattern)) issues.push(`${label} differs`);
        if (digest(Buffer.from(extract(html, /(<main\b[\s\S]*?<\/main>)/))) !== digest(Buffer.from(extract(expected, /(<main\b[\s\S]*?<\/main>)/)))) issues.push('Rendered main content differs');
        const alternateTags = source => (source.match(/<link rel="alternate"[^>]+>/g) || []).sort().join('\n');
        if (alternateTags(html) !== alternateTags(expected)) issues.push('hreflang set differs');
        if (!response.headers.get('content-type')?.includes('text/html')) issues.push('Not an HTML response');
      } else if (task.type === 'sitemap') {
        if (html !== localSitemap) issues.push('Sitemap differs');
      } else if (!html.includes('Sitemap: https://norva.tv/sitemap-blog.xml') || /Disallow:\s*\/blog/.test(html)) issues.push('Blog discovery blocked or sitemap missing');
      results.push({ ...task, status: response.status, cache: response.headers.get('cf-cache-status'), bytes: bytes.length, issues });
    } catch (error) { results.push({ ...task, issues: [error.message] }); }
  }
}
Promise.all(Array.from({ length: 5 }, worker)).then(() => {
  const report = { checkedAt: new Date().toISOString(), origin, publicPages: routes.length, evidenceImages: images.size,
    checks: results.length, failures: results.filter(result => result.issues.length), results };
  if (outputArg) fs.writeFileSync(path.resolve(outputArg.slice(9)), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
  if (report.failures.length) process.exitCode = 1;
});
