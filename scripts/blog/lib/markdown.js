'use strict';

/**
 * Focused Markdown -> HTML renderer for the Norva blog corpus.
 *
 * The 1,000 drafts use a deliberately small Markdown subset (verified by
 * scanning the corpus): H1-H3 headings, paragraphs, `-`/`*` unordered lists,
 * `N.` ordered lists, `>` blockquotes, GitHub pipe tables, fenced code blocks,
 * horizontal rules, and inline **bold** / *italic* / `code` / [links](url).
 * Standalone images use ![descriptive alt](/assets/blog/file.webp "caption").
 * They must resolve to a local, dimensioned raster or safe SVG asset. Raw HTML
 * is never accepted. We render the subset without rewriting article prose.
 *
 * Two blog-specific behaviours:
 *   - The body's single H1 is dropped: the page template renders exactly one
 *     visible H1 from the front-matter title.
 *   - Internal /blog/<slug>/ links whose target is not yet published are
 *     unwrapped to plain text, so a live article never links to a draft URL.
 */

const { escapeHtml, escapeAttr, slugifyHeading } = require('./format');
const fs = require('fs');
const path = require('path');
const PUBLIC_DIR = path.resolve(__dirname, '../../../public');

function isSafeLink(url) {
  return typeof url === 'string' && !/[\\\s<>"'\u0000-\u001f]/.test(url)
    && (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url) || /^#/.test(url));
}

function staticSvgDimensions(svg) {
  // This is a deliberately small editorial SVG profile, not a general SVG
  // sanitizer. Validate decoded XML names/values before serving the original
  // file, which must also remain inert when opened directly in a browser.
  const sax = require('sax'); // Already a locked application dependency.
  const namespace = 'http://www.w3.org/2000/svg';
  const elements = new Set(['svg', 'title', 'desc', 'defs', 'pattern', 'g', 'rect', 'path', 'circle', 'text']);
  const numeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|%)?$/i;
  const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  const numericAttrs = new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size']);
  const values = {
    id: (value) => identifier.test(value),
    'aria-labelledby': (value) => value.split(/\s+/).every((id) => identifier.test(id)),
    role: (value) => value === 'img',
    fill: (value) => /^(?:#[\da-f]{3,8}|none|currentColor|transparent|black|white|url\(#[A-Za-z_][A-Za-z0-9_.-]*\))$/i.test(value),
    stroke: (value) => /^(?:#[\da-f]{3,8}|none|currentColor|transparent|black|white|url\(#[A-Za-z_][A-Za-z0-9_.-]*\))$/i.test(value),
    'font-family': (value) => /^[A-Za-z][A-Za-z0-9 ,'\-]*$/.test(value),
    'font-weight': (value) => /^(?:normal|bold|[1-9]00)$/.test(value),
    'text-anchor': (value) => /^(?:start|middle|end)$/.test(value),
    patternUnits: (value) => /^(?:userSpaceOnUse|objectBoundingBox)$/.test(value),
    viewBox: (value) => {
      const numbers = value.trim().split(/[\s,]+/).map(Number);
      return numbers.length === 4 && numbers.every(Number.isFinite) && numbers[2] > 0 && numbers[3] > 0;
    },
    d: (value) => /^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/.test(value),
    transform: (value) => /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-+\d.eE,\s]+\)\s*)+$/.test(value),
  };
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  let rootAttributes;
  let depth = 0;
  let count = 0;
  let attributes = new Set();
  const reject = (reason) => { throw new Error(`Unsafe blog SVG: ${reason}`); };
  parser.onerror = (error) => reject(`invalid XML (${error.message})`);
  parser.ondoctype = () => reject('DOCTYPE is not supported');
  parser.onsgmldeclaration = () => reject('declarations are not supported');
  parser.onprocessinginstruction = () => reject('processing instructions are not supported');
  parser.onopencdata = () => reject('CDATA is not supported');
  parser.onopentagstart = () => { attributes = new Set(); };
  parser.onopennamespace = (binding) => {
    if (binding.prefix || binding.uri !== namespace || depth !== 0) reject('only the root default SVG namespace is supported');
  };
  parser.onattribute = (attribute) => {
    if (attributes.has(attribute.name)) reject('duplicate attribute');
    attributes.add(attribute.name);
  };
  parser.onopentag = (node) => {
    if (node.prefix || node.uri !== namespace || !elements.has(node.name)) reject(`unsupported element ${node.name}`);
    if (depth === 0) {
      if (rootAttributes || node.name !== 'svg') reject('exactly one SVG root is required');
      rootAttributes = node.attributes;
    } else if (node.name === 'svg') reject('nested SVG roots are not supported');
    if (++depth > 32 || ++count > 5000) reject('document exceeds editorial limits');
    for (const [name, attribute] of Object.entries(node.attributes)) {
      if (name === 'xmlns') {
        if (depth !== 1 || attribute.value !== namespace) reject('invalid namespace declaration');
        continue;
      }
      if (attribute.prefix || attribute.uri) reject(`namespaced attribute ${name}`);
      const valid = numericAttrs.has(name) ? numeric.test(attribute.value) : values[name]?.(attribute.value);
      if (!valid) reject(`unsupported attribute or value ${name}`);
    }
  };
  parser.onclosetag = () => { depth--; };
  if (Buffer.byteLength(svg, 'utf8') > 2 * 1024 * 1024) reject('document exceeds size limit');
  parser.write(svg).close();
  if (!rootAttributes || depth !== 0) reject('incomplete SVG document');
  const number = (name) => /^\d+(?:\.\d+)?(?:px)?$/.test(rootAttributes[name]?.value || '') ? parseFloat(rootAttributes[name].value) : NaN;
  const width = number('width');
  const height = number('height');
  if (Number.isFinite(width) && Number.isFinite(height)) return [width, height];
  if (rootAttributes.viewBox) return rootAttributes.viewBox.value.trim().split(/[\s,]+/).map(Number).slice(2);
  reject('dimensions are missing');
}

function imageDimensions(bytes, extension) {
  if (extension === '.png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (extension === '.webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (type === 'VP8L' && bytes[20] === 0x2f) return [1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)), 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10))];
  }
  if (/^\.jpe?g$/.test(extension) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += size;
    }
  }
  if (extension === '.svg') {
    return staticSvgDimensions(bytes.toString('utf8'));
  }
  throw new Error(`Cannot read dimensions of blog image (${extension})`);
}

function resolveBlogImage(url, publicDir = PUBLIC_DIR) {
  if (!/^\/assets\/blog\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|svg)$/.test(url)) throw new Error(`Unsafe blog image path: ${url}`);
  const allowedRoot = fs.realpathSync(path.join(publicDir, 'assets/blog'));
  const rootRelative = path.relative(fs.realpathSync(publicDir), allowedRoot);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Blog image directory must remain within public');
  const file = fs.realpathSync(path.join(publicDir, url.slice(1)));
  const relative = path.relative(allowedRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) throw new Error('Blog image must be a file within public/assets/blog');
  const [width, height] = imageDimensions(fs.readFileSync(file), path.extname(file).toLowerCase());
  if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 20000)) throw new Error('Invalid blog image dimensions');
  return { width, height };
}

function renderInline(text, ctx) {
  // 1) Protect inline code spans from all other transforms.
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  // 2) Protect links before escaping prose (URLs must not be double escaped).
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    if (!isSafeLink(url) || (ctx && typeof ctx.isLinkSuppressed === 'function' && ctx.isLinkSuppressed(url))) {
      return label; // Keep the words, drop unsafe or unpublished links.
    }
    const resolved = ctx?.resolveLink ? ctx.resolveLink(url) : { href: url };
    if (!resolved || !isSafeLink(resolved.href)) return label;
    const href = escapeAttr(resolved.href);
    const external = /^https?:\/\//i.test(resolved.href) && !/^https?:\/\/(?:www\.)?norva\.tv(?:[/:?#]|$)/i.test(resolved.href);
    const rel = external ? ' rel="noopener"' : '';
    const target = external ? ' target="_blank"' : '';
    const language = resolved.language ? ` hreflang="${escapeAttr(resolved.language)}"` : '';
    links.push(`<a href="${href}"${target}${rel}${language}>${escapeHtml(label)}${resolved.note ? ` <span class="link-language">(${escapeHtml(resolved.note)})</span>` : ''}</a>`);
    return `\u0000LINK${links.length - 1}\u0000`;
  });
  s = escapeHtml(s);

  // 4) Bold, then italic. Non-greedy, avoids empty matches.
  s = s.replace(/\*\*([^\s](?:[^*]*[^\s])?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^\s_](?:[^_]*[^\s_])?)_(?![\w_])/g, '$1<em>$2</em>');

  // 5) Restore safe links and code spans.
  s = s.replace(/\u0000LINK(\d+)\u0000/g, (_, n) => links[+n]);
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, n) => `<code>${escapeHtml(codes[+n])}</code>`);
  return s;
}

function isTableSeparator(line) {
  const t = line.trim();
  if (!t.includes('|') || !/-/.test(t)) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  // Split on unescaped pipes.
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/**
 * Render a markdown body to HTML.
 * @param {string} body
 * @param {object} ctx  { isLinkSuppressed(url), headings: [] (out) }
 */
function renderMarkdown(body, ctx = {}) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = ctx.headings || [];
  const usedHeadingIds = new Set();
  let firstH1Dropped = false;
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length) {
      out.push(`<p>${renderInline(buf.join(' '), ctx)}</p>`);
      buf.length = 0;
    }
  };

  const paragraph = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line -> paragraph break.
    if (trimmed === '') {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    // Fenced code block.
    const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flushParagraph(paragraph);
      const marker = fence[1][0];
      const lang = fence[2].trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker.repeat(3))) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      const cls = lang ? ` class="language-${escapeAttr(lang.split(/\s+/)[0])}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}\n</code></pre>`);
      continue;
    }

    // Informative image: standalone only, local file only, required alt text.
    if (trimmed.startsWith('![')) {
      flushParagraph(paragraph);
      const match = trimmed.match(/^!\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"([^"\n]*)")?\)$/);
      if (!match || !match[1].trim()) throw new Error('Invalid blog image syntax or missing alt text');
      const [, alt, src, caption] = match;
      const { width, height } = resolveBlogImage(src, ctx.publicDir);
      out.push(`<figure class="article-figure"><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async"><figcaption>${caption ? escapeHtml(caption) : ''}<a class="article-figure-link" href="${escapeAttr(src)}" target="_blank" rel="noopener">${escapeHtml(ctx.ui?.fullSizeImage || 'Open full-size image (new tab)')}</a></figcaption></figure>`);
      i++;
      continue;
    }

    // Heading.
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      const rawText = heading[2].replace(/\s+#+\s*$/, '').trim();
      if (level === 1 && !firstH1Dropped) {
        // The template renders the title as the page's single H1.
        firstH1Dropped = true;
        i++;
        continue;
      }
      const renderLevel = Math.min(level === 1 ? 2 : level, 6);
      // Stable English anchors make existing deep links work in every locale.
      // Translated documents must preserve the source's heading structure.
      const base = ctx.headingAliases?.[headings.length] || slugifyHeading(rawText) || 'section';
      let id = base;
      let suffix = 2;
      while (usedHeadingIds.has(id)) id = `${base}-${suffix++}`;
      usedHeadingIds.add(id);
      headings.push({ level: renderLevel, text: rawText, id });
      out.push(`<h${renderLevel} id="${escapeAttr(id)}">${renderInline(rawText, ctx)}</h${renderLevel}>`);
      i++;
      continue;
    }

    // Horizontal rule (standalone, not a table separator).
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(paragraph);
      out.push('<hr>');
      i++;
      continue;
    }

    // GitHub pipe table: current line has a pipe and the next line is a separator.
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph(paragraph);
      const header = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        if (l && r) return 'center';
        if (r) return 'right';
        if (l) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const alignAttr = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '');
      let html = `<div class="table-wrap" role="region" aria-label="${escapeAttr(ctx.ui?.scrollableTable || 'Scrollable table')}" tabindex="0"><table>\n<thead><tr>`;
      header.forEach((c, n) => { html += `<th scope="col"${alignAttr(n)}>${renderInline(c, ctx)}</th>`; });
      html += '</tr></thead>\n<tbody>';
      for (const row of rows) {
        html += '<tr>';
        for (let n = 0; n < header.length; n++) {
          html += `<td${alignAttr(n)}>${renderInline(row[n] || '', ctx)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody>\n</table></div>';
      out.push(html);
      continue;
    }

    // Blockquote (consecutive `>` lines).
    if (/^>\s?/.test(trimmed)) {
      flushParagraph(paragraph);
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quote.join(' '), ctx)}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph(paragraph);
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it, ctx)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph(paragraph);
      const items = [];
      let start = null;
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^(\d+)[.)]\s+(.*)$/);
        if (start === null) start = parseInt(m[1], 10);
        items.push(m[2]);
        i++;
      }
      const startAttr = start && start !== 1 ? ` start="${start}"` : '';
      out.push(`<ol${startAttr}>${items.map((it) => `<li>${renderInline(it, ctx)}</li>`).join('')}</ol>`);
      continue;
    }

    // Default: paragraph text.
    paragraph.push(trimmed);
    i++;
  }
  flushParagraph(paragraph);

  return out.join('\n');
}

module.exports = { renderMarkdown, renderInline, isSafeLink, resolveBlogImage };
