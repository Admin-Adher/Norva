'use strict';
// Local-only component preview. Reuses the actual Settings markup and styles.
// It deliberately does not simulate authentication or call any production API.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../public');
const source = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const start = source.indexOf('<div class="settings-section settings-language-section">');
const end = source.indexOf('<div id="settings-service-health"', start);
if (start < 0 || end < 0) throw new Error('Settings language section not found');
const fixture = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/i18n.css">
<script src="/js/i18n.js"></script></head><body>
<main style="max-width:900px;margin:32px auto;padding:16px">
<h1 data-i18n="ui_settings">Settings</h1>
${source.slice(start, end)}
<button class="btn btn-secondary" id="focus-after" data-i18n="ui_back">Back</button>
<p translate="no" id="provider-title">Provider title: English · Français · العربية</p>
</main></body></html>`;
http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture); }
    if (url.pathname === '/js/i18n.js' && process.argv.includes('--draft-runtime')) { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fs.readFileSync(path.join(root,'../output/i18n/preview-runtime.js'))); }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end();
    }
    const type = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.setHeader('Content-Type', type + '; charset=utf-8');
    fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT) || 4179, '127.0.0.1', () => console.log('Language component preview ready'));
