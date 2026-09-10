'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { splitDocument } = require('./frontmatter');
const { blogPath } = require('./localization');

// Selection is explicit, not inferred from whichever translations happen to exist.
// Original source URLs and first-publication instants remain locked across batches.
function loadTranslationSelection(contentDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, 'translations/selection.json'), 'utf8'));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.batches) || !manifest.batches.length) {
    throw new Error('Invalid translation selection manifest');
  }
  const published = JSON.parse(fs.readFileSync(path.join(contentDir, 'published-state.json'), 'utf8')).published;
  if (!published || typeof published !== 'object' || Array.isArray(published)) throw new Error('Invalid English publication state');
  const files = fs.readdirSync(path.join(contentDir, 'articles')).filter(file => /^\d+-.*\.md$/.test(file));
  const batchIds = new Set(), ids = new Set(), slugs = new Set(), sources = [];
  for (const batch of manifest.batches) {
    if (!batch || typeof batch.id !== 'string' || !batch.id.trim() || batchIds.has(batch.id)
      || !Array.isArray(batch.sources) || !batch.sources.length) throw new Error('Invalid or duplicate translation selection batch');
    batchIds.add(batch.id);
    for (const entry of batch.sources) {
      if (!entry || !Number.isInteger(entry.content_id) || entry.content_id < 1 || ids.has(entry.content_id)) {
        throw new Error('Invalid or duplicate selected source ID');
      }
      ids.add(entry.content_id);
      if (typeof entry.source_slug !== 'string' || !entry.source_slug || slugs.has(entry.source_slug)) {
        throw new Error('Invalid or duplicate selected source slug');
      }
      const canonical = 'https://norva.tv' + blogPath('en', entry.source_slug);
      slugs.add(entry.source_slug);
      if (typeof entry.source_published_at !== 'string' || !Number.isFinite(Date.parse(entry.source_published_at))
        || published[String(entry.content_id)] !== entry.source_published_at) {
        throw new Error(`Selected source is unpublished or its original publication date changed: ${entry.content_id}`);
      }
      const matches = files.filter(file => Number(file.match(/^(\d+)-/)[1]) === entry.content_id);
      if (matches.length !== 1) throw new Error(`Selected source must resolve to exactly one file: ${entry.content_id}`);
      const raw = fs.readFileSync(path.join(contentDir, 'articles', matches[0]), 'utf8');
      const { data, body } = splitDocument(raw);
      if (data.slug !== entry.source_slug || data.canonical_url !== canonical) {
        throw new Error(`Selected source URL identity changed: ${entry.content_id}`);
      }
      sources.push({ ...entry, batch_id: batch.id, filename: matches[0], raw, data, body });
    }
  }
  return { manifest, sources };
}

module.exports = { loadTranslationSelection };
