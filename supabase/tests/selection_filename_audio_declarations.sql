-- Run after the migration in a transaction, and roll back both for dry-run QA.
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(10);
create temporary table filename_audio_fixture as
select jsonb_build_object('selectionRevision','selection-vod-20260906-v1',
  'discoveryFeed','klysmgt-tested-vod',
  'selectionPlaybackValidation',jsonb_build_object('urlSha256',repeat('a',64)),
  'selectionFilenameAudio',jsonb_build_object('version',1,'language','es','urlSha256',repeat('a',64))) as metadata,
  'norva-selection:movie:' || repeat('b',64) as external_id;
select is(public.selection_provider_audio_language(metadata,external_id),'es','explicit filename is a catalogue declaration') from filename_audio_fixture;
select is(public.selection_provider_audio_language(metadata - 'selectionFilenameAudio',external_id),null,'absent declaration stays unknown') from filename_audio_fixture;
select is(public.selection_provider_audio_language(metadata,'other-file'),null,'unrelated file is excluded') from filename_audio_fixture;
select is(public.selection_provider_audio_language(metadata,replace(external_id,':movie:',':series:')),null,'episode filename cannot declare its whole series') from filename_audio_fixture;
select is(public.selection_provider_audio_language(metadata || '{"discoveryFeed":"unreviewed"}',external_id),null,'unreviewed feed is excluded') from filename_audio_fixture;
select is(public.selection_provider_audio_language(jsonb_set(metadata,'{selectionPlaybackValidation,urlSha256}',to_jsonb(repeat('c',64))),external_id),null,'changed URL proof is excluded') from filename_audio_fixture;
select is(public.selection_provider_audio_language(jsonb_set(metadata,'{selectionFilenameAudio,language}','"und"'),external_id),null,'unknown language is not a declaration') from filename_audio_fixture;
select is(public.selection_provider_audio_language(jsonb_set(metadata,'{selectionFilenameAudio,version}','"1"'),external_id),null,'malformed declaration is excluded') from filename_audio_fixture;
select is(public.selection_provider_audio_language('{"selectionRevision":"selection-vod-20260906-v1","discoveryFeed":"babuperumana-vod","selectionVodGroup":"Movies / Telugu / 2026"}',external_id),'te','existing category declarations are preserved') from filename_audio_fixture;
select ok(not has_function_privilege('authenticated','public.selection_provider_audio_language(jsonb,text)','EXECUTE'),'declaration reader remains service-only');
select * from finish();
