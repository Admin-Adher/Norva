'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tags = /<(?:script|link)\b[^>]*>/gi;
function references(html) {
  return [...html.matchAll(tags)].flatMap(([tag]) => {
    const match = tag.match(/\b(src|href)="(\/[^"?#]+)(?:\?[^"#]*)?"/);
    return match && /^\/(?:js|css)\/.+\.(?:js|css)$/.test(match[2])
      ? [{ tag, attribute: match[1], url: match[2] }] : [];
  });
}
function fingerprint(publicDir) {
  const app = path.join(publicDir, 'app.html');
  const manifestPath = path.join(publicDir, 'app-assets.json');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).assets : [];
  let html = fs.readFileSync(app, 'utf8');
  const assets = new Map();
  for (const ref of references(html)) {
    const source = previous.find(a => a.url === ref.url)?.source || ref.url;
    const absolute = path.resolve(publicDir, '.' + source);
    if (!absolute.startsWith(path.resolve(publicDir) + path.sep)) throw Error('Asset outside public directory');
    const bytes = fs.readFileSync(absolute);
    const sha256 = digest(bytes);
    const extension = path.posix.extname(source);
    const url = source.slice(0, -extension.length) + '.' + sha256.slice(0, 16) + extension;
    const target = path.resolve(publicDir, '.' + url);
    if (fs.existsSync(target) && digest(fs.readFileSync(target)) !== sha256) throw Error('Immutable asset collision');
    fs.writeFileSync(target, bytes);
    const integrity = 'sha256-' + Buffer.from(sha256, 'hex').toString('base64');
    const nextTag = ref.tag.replace(new RegExp('\\b' + ref.attribute + '="[^"]+"'), ref.attribute + '="' + url + '"')
      .replace(/\s+integrity="[^"]*"/g, '').replace(/\s*\/?>$/, ' integrity="' + integrity + '">');
    html = html.replace(ref.tag, nextTag);
    assets.set(url, { source, url, sha256, integrity });
  }
  if (!assets.size) throw Error('No application assets found');
  const manifest = { contract: 'norva.app-assets.v1', assets: [...assets.values()] };
  fs.writeFileSync(app, html);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
module.exports = { fingerprint, references, digest };
if (require.main === module) {
  const result = fingerprint(path.resolve(process.argv[2] || path.join(__dirname, '../public')));
  console.log('Fingerprinted ' + result.assets.length + ' application assets');
}
