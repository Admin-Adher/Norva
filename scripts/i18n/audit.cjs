'use strict';
// Candidate inventory, not a false promise that regex/AST can certify all UI copy.
// Dynamic strings still require contextual review before extraction/translation.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const parse5 = require('parse5');
const root = path.resolve(__dirname, '../..');
const candidates = [];
function walkFiles(dir) {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
        const file = `${dir}/${entry.name}`;
        return entry.isDirectory() ? walkFiles(file) : [file];
    });
}
const readable = text => /[a-zA-Z\u00c0-\uffff]{2}/.test(text) && !/^\s*(?:https?:|\/|#[\w-]+$)/.test(text);
function add(file, line, kind, text) {
    text = String(text).replace(/\s+/g, ' ').trim();
    if (readable(text)) candidates.push({ file, line: line || 1, kind, text });
}
function html(file, source, baseLine = 0) {
    const document = parse5.parseFragment(source, { sourceCodeLocationInfo: true });
    function visit(node, skip = false) {
        const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
        skip ||= ['script','style','code','pre'].includes(node.tagName) || attrs.translate === 'no';
        if (!skip) {
            if (node.nodeName === '#text' && !node.parentNode?.attrs?.some(a => a.name === 'data-i18n')) {
                add(file, baseLine + (node.sourceCodeLocation?.startLine || 1), 'html-text', node.value);
            }
            for (const name of ['title','placeholder','aria-label','alt']) {
                if (attrs[name] && !attrs[`data-i18n-${name}`]) add(file, baseLine + (node.sourceCodeLocation?.startLine || 1), name, attrs[name]);
            }
        }
        (node.childNodes || []).forEach(child => visit(child, skip));
    }
    visit(document);
}
const publicFiles = fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.html') && !['probe.html'].includes(f));
for (const file of publicFiles) html(`public/${file}`, fs.readFileSync(path.join(root, 'public', file), 'utf8'));
const parseErrors = [];
for (const file of walkFiles('public/js').filter(f => f.endsWith('.js') && !/\/vendor\//.test(f) && f !== 'public/js/i18n.js')) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    let tree;
    try { tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
    catch (error) { parseErrors.push({ file, message: error.message }); continue; }
    function visit(node, parent) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'TemplateLiteral') {
            const text = node.quasis.map(q => q.value.cooked || '').join(' {{dynamic}} ');
            if (/<[a-z][\s\S]*>/i.test(text)) html(file, text, node.loc.start.line - 1);
        }
        if (node.type === 'Literal' && typeof node.value === 'string') {
            const p = parent;
            const property = p?.type === 'AssignmentExpression' && p.left?.property?.name;
            const call = p?.type === 'CallExpression' && (p.callee?.property?.name || p.callee?.name);
            const objectKey = p?.type === 'Property' && (p.key?.name || p.key?.value);
            if (['textContent','innerText','placeholder','title'].includes(property)
                || ['alert','confirm','showToast','toast','showError'].includes(call)
                || ['label','message','hint','placeholder','description'].includes(objectKey)) {
                add(file, node.loc.start.line, 'js-ui-candidate', node.value);
            }
        }
        for (const [key, child] of Object.entries(node)) {
            if (key === 'loc') continue;
            if (Array.isArray(child)) child.forEach(value => visit(value, node));
            else if (child && typeof child === 'object') visit(child, node);
        }
    }
    visit(tree);
}
for (const platform of ['phone','tv']) {
    const base = `clients/android-${platform}/app/src/main`;
    for (const file of walkFiles(`${base}/java`).filter(f => f.endsWith('.java'))) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const re = /\.(?:setText|setTitle|setMessage|setContentDescription|setHint)\(\s*"((?:\\.|[^"\\])*)"/g;
        for (const match of source.matchAll(re)) add(file, source.slice(0, match.index).split('\n').length, 'native-literal', match[1]);
    }
}
const result = { note: 'Candidates need review. Excludes blog articles, vendor UI, backend messages and nonliteral runtime copy; zero candidates alone does not certify 100% coverage.',
    catalogMessages: Object.keys(require('../../i18n/messages.json')).length,
    locales: require('../../i18n/locales.json').map(l => l.code), candidates, parseErrors };
function resourceKeys(directory) {
    const full = path.join(root, directory);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full).filter(file => file.endsWith('.xml')).flatMap(file => {
        const text = fs.readFileSync(path.join(full, file), 'utf8');
        return [...text.matchAll(/<string\s+([^>]+)>/g)]
            .filter(match => !/translatable="false"/.test(match[1]))
            .map(match => match[1].match(/name="([^"]+)"/)?.[1]).filter(Boolean);
    });
}
result.nativeResources = {};
for (const platform of ['phone','tv']) {
    const base = `clients/android-${platform}/app/src/main/res`;
    const common = 'clients/android-common/src/main/res';
    const reference = new Set([...resourceKeys(`${base}/values`), ...resourceKeys(`${common}/values`)]);
    result.nativeResources[platform] = require('../../i18n/locales.json').map(locale => {
        const present = new Set([...resourceKeys(`${base}/${locale.android}`), ...resourceKeys(`${common}/${locale.android}`)]);
        const missing = [...reference].filter(key => !present.has(key));
        return { language: locale.code, total: reference.size, translatedKeys: reference.size - missing.length, missing };
    });
}
const output = path.join(root, 'output/i18n/inventory.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ catalogMessages: result.catalogMessages, languages: result.locales.length,
    candidates: candidates.length, parseErrors, nativeResources: Object.fromEntries(Object.entries(result.nativeResources).map(([platform, rows]) =>
        [platform, rows.map(({ language, total, translatedKeys }) => ({ language, total, translatedKeys }))])), output }, null, 2));
if (process.argv.includes('--check-coverage') && (candidates.length || parseErrors.length)) process.exitCode = 1;
