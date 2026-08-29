import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const archive = path.join(root, 'prototype-archive');
const failures = [];

function requireFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    failures.push(`missing file: ${relativePath}`);
  }
  return absolutePath;
}

const required = [
  'README.md',
  'MIGRATION_TO_PRODUCTION.md',
  'STATE_AND_CONTRACT_MAP.md',
  'RELEASE_AND_QA_CHECKLIST.md',
  'migration-manifest.json',
  'prototype-archive/l-premium-continuity.html',
  'prototype-archive/profile-funnels.html',
  'prototype-archive/qa-l.html',
  'prototype-archive/prototype.css',
  'prototype-archive/prototype.js',
  'prototype-archive/design-qa.md'
];
required.forEach(requireFile);

for (let index = 1; index <= 12; index += 1) {
  requireFile(`prototype-archive/assets/avatars/avatar-${String(index).padStart(2, '0')}.png`);
}

const finalHtmlPath = path.join(archive, 'l-premium-continuity.html');
const finalHtml = fs.readFileSync(finalHtmlPath, 'utf8');
const prototypeJs = fs.readFileSync(path.join(archive, 'prototype.js'), 'utf8');
const prototypeCss = fs.readFileSync(path.join(archive, 'prototype.css'), 'utf8');

const requiredStates = [
  'data-l-view="welcome"',
  'data-l-view="auth"',
  'data-l-view="profiles"',
  'data-l-step="identity"',
  'data-l-step="code"',
  'data-l-step="credential"',
  'data-profile-screen="chooser"',
  'data-profile-screen="loading"',
  'data-profile-screen="manage"',
  'data-profile-screen="setup"',
  'data-profile-screen="edit"',
  'data-profile-screen="avatars"',
  'data-profile-screen="created"',
  'data-profile-screen="arrival"'
];
for (const marker of requiredStates) {
  if (!finalHtml.includes(marker)) failures.push(`missing state marker: ${marker}`);
}

if (!finalHtml.includes('>Get started<')) failures.push('single Get started action is missing');
if (/\bKids\b/i.test(finalHtml)) failures.push('final candidate unexpectedly contains Kids UI');
if (!prototypeCss.includes('@media (prefers-reduced-motion: reduce)')) failures.push('reduced-motion fallback is missing');
if (!prototypeCss.includes('@keyframes premium-posters-rise')) failures.push('poster-column animation is missing');

const forbiddenRuntime = [
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bNorvaAuth\b/, 'NorvaAuth'],
  [/\bNorvaCloud\b/, 'NorvaCloud']
];
for (const [pattern, label] of forbiddenRuntime) {
  if (pattern.test(prototypeJs)) failures.push(`prototype must stay inert but contains ${label}`);
}

const localReferencePattern = /(?:src|href)="([^"]+)"/g;
for (const htmlName of ['l-premium-continuity.html', 'profile-funnels.html', 'qa-l.html']) {
  const html = fs.readFileSync(path.join(archive, htmlName), 'utf8');
  for (const match of html.matchAll(localReferencePattern)) {
    const reference = match[1];
    if (/^(?:#|data:|https?:|mailto:|tel:)/.test(reference)) continue;
    const cleanReference = reference.split(/[?#]/, 1)[0];
    if (!cleanReference) continue;
    const target = path.resolve(archive, cleanReference);
    if (!target.startsWith(archive + path.sep) || !fs.existsSync(target)) {
      failures.push(`${htmlName} has missing or unsafe local reference: ${reference}`);
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'migration-manifest.json'), 'utf8'));
if (!['local_deferred_candidate', 'production_candidate_authorized'].includes(manifest.status)) {
  failures.push('manifest status is not an allowed gated state');
}
if (manifest.status === 'production_candidate_authorized' && !manifest.authorization?.requiresEvidence) {
  failures.push('authorized production candidate must require evidence');
}
if (manifest.decisions?.kidsProfiles !== false) failures.push('manifest must explicitly disable Kids profiles');

if (failures.length) {
  console.error('auth-profile bundle: FAIL');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('auth-profile bundle: PASS');
  console.log(`validated states=${requiredStates.length} avatars=12 inert=true`);
}
