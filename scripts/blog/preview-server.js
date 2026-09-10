#!/usr/bin/env node
'use strict';
// Read-only local static preview, deliberately no SPA fallback for missing guides.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(path.resolve(__dirname, '../../public'));
const port = Number(process.argv[2] || 4181);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const requestPath = decodeURIComponent(url.pathname);
    let file = path.resolve(root, '.' + requestPath);
    const inside = target => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
    if (!inside(file)) throw new Error('Outside public');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file) && !path.extname(file)) file += '.html';
    file = fs.realpathSync(file);
    if (!inside(file) || !fs.statSync(file).isFile()) throw new Error('Missing file');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Blog preview: http://127.0.0.1:${port}/blog/`));
