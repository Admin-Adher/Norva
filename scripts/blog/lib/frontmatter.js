'use strict';

/**
 * Zero-dependency parser for the YAML front matter used by the Norva blog
 * drafts. The corpus is machine-generated and uniform (see
 * content/blog/ARTICLE-TEMPLATE.md), so we only need the subset of YAML the
 * drafts actually use:
 *
 *   - top-level scalars                     key: "value"
 *   - one-level nested maps                 author:\n  name: "…"
 *   - block sequences of scalars            sources:\n- "…"  (indented or not)
 *   - inline empty/flow collections         related_articles: []
 *   - scalars: quoted strings, integers, floats, booleans, null
 *
 * It is intentionally strict about the shapes above rather than a general YAML
 * engine. build-blog.js validates every parsed draft, so a malformed file is
 * caught loudly instead of silently mis-rendered.
 */

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  // Double-quoted string.
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  // Single-quoted string (YAML doubles '' to escape a quote).
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  // Inline flow sequence: ["a", "b"]
  if (s[0] === '[' && s[s.length - 1] === ']') {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner).map(parseScalar);
  }
  // Numbers.
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  // Bare string.
  return s;
}

// Split a flow-sequence body on commas that are not inside quotes.
function splitFlow(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

const indentOf = (line) => line.match(/^ */)[0].length;

function parseFrontmatter(yaml) {
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === '') i++;
  };

  function parseList(col) {
    const arr = [];
    while (true) {
      skipBlank();
      if (i >= lines.length) break;
      if (indentOf(lines[i]) !== col) break;
      const body = lines[i].slice(col);
      if (!body.startsWith('- ') && body !== '-') break;
      arr.push(parseScalar(body.slice(1).trim()));
      i++;
    }
    return arr;
  }

  function parseMap(col) {
    const obj = {};
    while (true) {
      skipBlank();
      if (i >= lines.length) break;
      const ind = indentOf(lines[i]);
      if (ind !== col) break; // dedent (end of this map) or unexpected indent
      const body = lines[i].slice(col);
      if (body.startsWith('- ')) break; // a sequence item, not a map key
      const m = body.match(/^([A-Za-z0-9_.-]+):(.*)$/);
      if (!m) break;
      const key = m[1];
      const rest = m[2].trim();
      i++;
      if (rest !== '') {
        obj[key] = parseScalar(rest);
        continue;
      }
      // Empty value: look ahead to classify as nested map, block list, or null.
      skipBlank();
      if (i >= lines.length) { obj[key] = null; continue; }
      const nind = indentOf(lines[i]);
      const nbody = lines[i].slice(nind);
      if ((nbody.startsWith('- ') || nbody === '-') && nind >= col) {
        obj[key] = parseList(nind);
      } else if (nind > col) {
        obj[key] = parseMap(nind);
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  return parseMap(0);
}

/**
 * Split a raw markdown file into { data, body }. The file must open with a
 * `---` fence; if it does not, the whole file is treated as body.
 */
function splitDocument(raw) {
  const text = raw.replace(/^﻿/, ''); // strip BOM
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: text };
  }
  let end = -1;
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].trim() === '---') { end = k; break; }
  }
  if (end === -1) return { data: {}, body: text };
  const yaml = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { data: parseFrontmatter(yaml), body };
}

module.exports = { parseFrontmatter, splitDocument, parseScalar };
