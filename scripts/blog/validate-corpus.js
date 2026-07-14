#!/usr/bin/env node
'use strict';

/**
 * Renders every draft in content/blog/articles and reports any parsing or
 * Markdown-conversion problem, so we know the auto-publisher will handle all
 * 1,000 articles — not just the first batch — without leaking raw Markdown.
 * Run: node scripts/blog/validate-corpus.js
 */

const fs = require('fs');
const path = require('path');
const { splitDocument } = require('./lib/frontmatter');
const { renderMarkdown } = require('./lib/markdown');

const ARTICLES_DIR = path.join(__dirname, '..', '..', 'content', 'blog', 'articles');
const REQUIRED = ['title', 'slug', 'meta_description', 'canonical_url'];

let files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.md')).sort();
const problems = [];
let tables = 0; let codeBlocks = 0; let totalH2 = 0;

for (const name of files) {
  const raw = fs.readFileSync(path.join(ARTICLES_DIR, name), 'utf8');
  const { data, body } = splitDocument(raw);

  for (const key of REQUIRED) {
    if (!data[key] || String(data[key]).trim() === '') {
      problems.push(`${name}: missing/empty frontmatter '${key}'`);
    }
  }
  if (data.slug && !/^[a-z0-9-]+$/.test(String(data.slug))) {
    problems.push(`${name}: suspicious slug '${data.slug}'`);
  }

  const headings = [];
  let html;
  try {
    html = renderMarkdown(body, { headings });
  } catch (e) {
    problems.push(`${name}: render threw ${e.message}`);
    continue;
  }
  totalH2 += headings.filter((h) => h.level === 2).length;
  if (html.includes('<table>')) tables++;
  if (html.includes('<pre>')) codeBlocks++;

  // Artifact scans on the rendered HTML.
  if (/<h1[ >]/.test(html)) problems.push(`${name}: body still contains an <h1>`);
  if (html.includes('**')) problems.push(`${name}: leftover '**' (unconverted bold)`);
  if (/\]\([^)]*\)/.test(html)) problems.push(`${name}: leftover markdown link syntax`);
  if (/(^|\n)#{1,6} /.test(html)) problems.push(`${name}: leftover ATX heading`);
  if (/\|\s*-{3,}/.test(html)) problems.push(`${name}: leftover table separator row`);
  // Detect a JS `undefined` leaking into markup (inside a tag/attr), not prose.
  if (/="undefined"|>undefined<|>\s*undefined\s*</.test(html)) problems.push(`${name}: 'undefined' leaked into markup`);
  if (/<p>\s*<\/p>/.test(html)) problems.push(`${name}: empty paragraph emitted`);
}

console.log(`Validated ${files.length} articles.`);
console.log(`  tables rendered:      ${tables}`);
console.log(`  code blocks rendered: ${codeBlocks}`);
console.log(`  total H2 headings:    ${totalH2}`);
console.log(`  problems:             ${problems.length}`);
if (problems.length) {
  console.log('\nFirst 40 problems:');
  problems.slice(0, 40).forEach((p) => console.log('  - ' + p));
  process.exitCode = 1;
} else {
  console.log('\nOK — no parsing or conversion problems found.');
}
