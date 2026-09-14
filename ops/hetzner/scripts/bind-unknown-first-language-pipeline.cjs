// Produce immutable release artifacts from Git blobs, not a dirty working tree.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const git = process.env.NORVA_RELEASE_GIT || 'git';
const outputRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.statSync(outputRoot).isDirectory()) throw new Error('Existing artifact root required');
const commit = execFileSync(git, ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const migrations = ['20260914133000_unknown_first_language_intake.sql',
  '20260914134000_owned_provider_stream_languages.sql', '20260914135000_unknown_series_metadata_refresh.sql'];
const files = [...migrations.map(name=>'supabase/migrations/'+name),
  'ops/hetzner/scripts/deploy-unknown-first-language-pipeline.py'];
execFileSync(git, ['diff', '--exit-code', 'HEAD', '--', ...files]);
const directory = fs.mkdtempSync(path.join(outputRoot, 'unknown-first-release-'));
const manifest = {commit, migrations:{}, artifacts:{}};
for (const file of files) {
  const bytes = execFileSync(git, ['show', `${commit}:${file}`]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const name = path.basename(file);
  fs.writeFileSync(path.join(directory,name), bytes, {flag:'wx', mode:0o600});
  manifest.artifacts[name] = hash;
  if (migrations.includes(name)) manifest.migrations[name] = hash;
}
fs.writeFileSync(path.join(directory,'release-manifest.private.json'), JSON.stringify(manifest,null,2), {flag:'wx', mode:0o600});
console.log(JSON.stringify({directory,commit,files:files.length}));
