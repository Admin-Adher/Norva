import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public/js/components/SourceManager.js');
const canonical = fs.readFileSync(path.join(root, 'supabase/functions/_shared/source-input-policy.mjs'), 'utf8').replace(/\r\n/g, '\n');
const names = [...canonical.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1]);
if (names.length !== 6 || /^import\b/m.test(canonical)) throw new Error('Unexpected source-input policy exports/dependencies');
const begin = '// BEGIN GENERATED SOURCE INPUT POLICY';
const end = '// END GENERATED SOURCE INPUT POLICY';
const generated = `${begin}\nconst SourceInputPolicy = (() => {\n${canonical.replace(/^export /gm, '')}\nreturn Object.freeze({ ${names.join(', ')} });\n})();\n${end}`;
const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);
if (!pattern.test(source)) throw new Error('Source-input policy insertion markers missing');
const next = source.replace(pattern, () => generated);
if (process.argv.includes('--check')) {
  if (source !== next) throw new Error('Stale browser source-input policy: run node scripts/build-source-input-policy.mjs');
  console.log('SOURCE_INPUT_POLICY_PARITY_OK');
} else {
  if (source !== next) fs.writeFileSync(target, next);
  console.log('SOURCE_INPUT_POLICY_BUILT');
}
