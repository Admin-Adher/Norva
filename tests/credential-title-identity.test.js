const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../supabase/functions/norva-provider-access/index.ts'), 'utf8');
const functionText = (name, next) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(`\nfunction ${next}(`));
const context = { rpcObject: value => value || {}, nullableString: value => value ? String(value) : null,
  compactActiveRecord: value => value, activeReleaseYear: () => null, activeLanguageTag: () => null, WorkerFault: Error };
vm.runInNewContext(functionText('activeTitlePayload', 'activeTitleVariants') + '\n'
  + functionText('normalizedTitleIdentity', 'activeReleaseYear') + '\nglobalThis.build = activeTitlePayload;', context);
const build = metadata => context.build({userId: 'owner'}, [{item_type: 'series', title: 'البلاص', metadata}])[0];

test('non-Latin titles with provider identities never require a Latin slug', () => {
  const tmdb = build({providerTmdbId: '219564'});
  assert.equal(tmdb.identity_key, 'tmdb:219564');
  assert.equal(tmdb.title, 'البلاص');
  assert.equal(tmdb.identity_source, 'provider_tmdb');
  assert.equal(build({providerImdbId: 'tt1234567'}).identity_key, 'imdb:tt1234567');
  assert.equal(build({providerTmdbId: '219564', providerImdbId: 'tt1234567'}).identity_key, 'tmdb:219564');
});

test('normalized identity validation is retained only for titles without provider IDs', () => {
  assert.throws(() => build({}), /invalid_payload/);
  const row = context.build({userId: 'owner'}, [{item_type: 'movie', title: 'Été français', metadata: {}}])[0];
  assert.equal(row.identity_key, 'norm:ete-francais');
});
