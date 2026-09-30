'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UPSTREAM_REVISION = 'a421e43855164a8197daf9d8d40fe71c6996bb0d';
const FILE_HASHES = {
  'src/emulator-manager.ts': '1e9ca00c20d35d925440afc1ce82303c42cddc4c1ac196da65e39209ef87696f',
  'lib/emulator-manager.js': 'a63db8fe9ffb4fb3651e9a2c97f8bac5ca4ce0078a7bbe61ef2e02019082c577',
};

function replaceUnlock(source) {
  const prematureInput = 'shell input keyevent 82';
  if (source.split(prematureInput).length !== 2) {
    throw new Error('Expected exactly one upstream unlock input; refusing an ambiguous patch');
  }
  return '// Modified by Norva CI (2026-09-30): dismiss keyguard without dispatching an input before HOME has focus.\n'
    + source.replace(prematureInput, 'shell wm dismiss-keyguard');
}

function patchRunner(actionRoot) {
  // Validate every file before writing either one. An upstream change must be
  // reviewed; never silently skip this correction or patch an unknown runner.
  fs.accessSync(path.join(actionRoot, 'LICENSE'));
  const writes = Object.entries(FILE_HASHES).map(([file, expectedHash]) => {
    const target = path.join(actionRoot, file);
    const bytes = fs.readFileSync(target);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== expectedHash) throw new Error(`Unreviewed emulator runner file: ${file}`);
    return { target, source: replaceUnlock(bytes.toString('utf8')) };
  });
  for (const { target, source } of writes) fs.writeFileSync(target, source);
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Expected the checked-out action directory');
  patchRunner(path.resolve(process.argv[2]));
  console.log(`Phone emulator runner ${UPSTREAM_REVISION}: non-input keyguard dismissal applied; HOME/ANR gates unchanged.`);
}

module.exports = { replaceUnlock, patchRunner, UPSTREAM_REVISION };
