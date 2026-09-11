'use strict';

// LOCAL packaging only: no network, credentials, SQL, container operation or
// activation. Preserve the two bind-mount layouts from the installed compose.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { builtinModules } = require('node:module');
const acorn = require('acorn');
const ENTRY = 'ops/hetzner/services/selection-audio-worker.mjs';
const PREFIXES = ['ops/hetzner/services/', 'supabase/functions/_shared/'];
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function destination(source) {
    if (source.startsWith(PREFIXES[0])) return 'runner/' + source.slice(PREFIXES[0].length);
    if (source.startsWith(PREFIXES[1])) return 'functions/_shared/' + source.slice(PREFIXES[1].length);
    return fail('SELECTION_PACKAGE_SOURCE_SCOPE');
}

function imports(text) {
    const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const found = new Set();
    const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
            if (typeof node.source.value !== 'string') fail('SELECTION_PACKAGE_DYNAMIC_IMPORT');
            found.add(node.source.value);
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) for (const child of value) walk(child);
            else if (value && typeof value === 'object') walk(value);
        }
    };
    walk(ast);
    return [...found];
}

function privateRegularFile(root, relative) {
    const target = path.resolve(root, relative);
    const child = path.relative(root, target);
    if (!child || child.startsWith('..' + path.sep) || path.isAbsolute(child)) fail('SELECTION_PACKAGE_PATH_ESCAPE');
    let cursor = root;
    for (const part of child.split(path.sep)) {
        cursor = path.join(cursor, part);
        if (fs.lstatSync(cursor).isSymbolicLink()) fail('SELECTION_PACKAGE_SYMLINK');
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) fail('SELECTION_PACKAGE_FILE_INVALID');
    return fs.readFileSync(target);
}

function collectSelectionModules(repositoryRoot) {
    const root = fs.realpathSync(repositoryRoot);
    const modules = new Map(); let total = 0;
    const visit = source => {
        if (modules.has(source)) return;
        const target = destination(source);
        if (!source.endsWith('.mjs') || source.includes('\\')) fail('SELECTION_PACKAGE_SOURCE_SCOPE');
        const content = privateRegularFile(root, source);
        total += content.length;
        if (modules.size >= 128 || total > 24 * 1024 * 1024) fail('SELECTION_PACKAGE_TOO_LARGE');
        modules.set(source, { source, target, bytes: content.length, sha256: sha(content), content });
        for (const specifier of imports(content.toString('utf8'))) {
            if (specifier.startsWith('node:') && BUILTINS.has(specifier.slice(5))) continue;
            if (!specifier.startsWith('./') && !specifier.startsWith('../')) fail('SELECTION_PACKAGE_EXTERNAL_IMPORT');
            if (specifier.includes('?') || specifier.includes('#') || specifier.includes('\\')) fail('SELECTION_PACKAGE_SOURCE_SCOPE');
            visit(path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)));
        }
    };
    visit(ENTRY);
    return [...modules.values()].sort((a,b) => a.source.localeCompare(b.source, 'en'));
}

function manifestFor(modules) {
    const files = modules.map(({ content, ...entry }) => entry);
    return { protocol: 1, entry: ENTRY, files, contentSha256: sha(JSON.stringify(files)),
        activation: 'not-activated', canary: 'requires-runtime-scope-verification' };
}

function verifySelectionRelease(output, modules) {
    if (fs.lstatSync(output).isSymbolicLink()) fail('SELECTION_PACKAGE_SYMLINK');
    const root = fs.realpathSync(output);
    const expected = manifestFor(modules);
    const actual = JSON.parse(privateRegularFile(root, 'manifest.json').toString('utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('SELECTION_PACKAGE_MANIFEST_MISMATCH');
    const wanted = new Set(['manifest.json', ...modules.map(file => file.target)]);
    const walk = relative => {
        for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const name = relative ? relative + '/' + entry.name : entry.name;
            if (entry.isSymbolicLink()) fail('SELECTION_PACKAGE_SYMLINK');
            if (entry.isDirectory()) {
                if (![...wanted].some(file => file.startsWith(name + '/'))) fail('SELECTION_PACKAGE_EXTRA_FILE');
                walk(name);
            } else if (!entry.isFile() || !wanted.delete(name)) fail('SELECTION_PACKAGE_EXTRA_FILE');
        }
    };
    walk('');
    if (wanted.size) fail('SELECTION_PACKAGE_MISSING_FILE');
    for (const file of modules) {
        const bytes = privateRegularFile(root, file.target);
        if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) fail('SELECTION_PACKAGE_CONTENT_MISMATCH');
    }
    return { passed: true, files: modules.length, bytes: modules.reduce((sum,file) => sum + file.bytes,0),
        contentSha256: expected.contentSha256, providerRequests: 0, productionWrites: 0,
        activation: expected.activation, canary: expected.canary };
}

function packageSelectionRelease(output, modules) {
    if (!path.isAbsolute(output) || fs.existsSync(output)) fail('SELECTION_PACKAGE_DESTINATION_EXISTS_OR_RELATIVE');
    // A new explicitly named directory only; never replace an old release or
    // clean up a partially assembled/foreign directory automatically.
    const parent = path.dirname(output);
    if (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory()) fail('SELECTION_PACKAGE_PARENT_INVALID');
    fs.mkdirSync(output, { mode: 0o700 });
    for (const file of modules) {
        const target = path.join(output, file.target);
        fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
        fs.writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
    }
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifestFor(modules)), { flag:'wx',mode:0o600 });
    return verifySelectionRelease(output, modules);
}

module.exports = { collectSelectionModules, imports, manifestFor, packageSelectionRelease, verifySelectionRelease };

if (require.main === module) {
    try {
        const [mode, output, ...extra] = process.argv.slice(2);
        if (!['build','verify'].includes(mode) || !output || extra.length) fail('SELECTION_PACKAGE_ARGUMENTS');
        const modules = collectSelectionModules(path.resolve(__dirname, '../../..'));
        console.log(JSON.stringify((mode === 'build' ? packageSelectionRelease : verifySelectionRelease)(output, modules)));
    } catch (error) {
        // Never print imported source text, absolute source paths or secrets.
        console.error(error.code?.startsWith('SELECTION_PACKAGE_') ? error.code : 'SELECTION_PACKAGE_FAILED');
        process.exitCode = 1;
    }
}
