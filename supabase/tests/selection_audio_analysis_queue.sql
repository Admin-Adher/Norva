-- Run against an isolated test database. Every fixture is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok((select relrowsecurity and relforcerowsecurity
  from pg_class where oid='public.catalog_selection_audio_jobs'::regclass),
  'Selection audio jobs enforce RLS');
select extensions.ok(not has_table_privilege('anon','public.catalog_selection_audio_jobs','SELECT')
  and not has_table_privilege('authenticated','public.catalog_selection_audio_jobs','SELECT')
  and not has_table_privilege('service_role','public.catalog_selection_audio_jobs','UPDATE')
  and has_table_privilege('service_role','public.catalog_selection_audio_jobs','SELECT'),
  'only service workers may read jobs and all mutations require RPCs');
select extensions.ok(bool_and(not has_function_privilege('anon',routine,'EXECUTE')
  and not has_function_privilege('authenticated',routine,'EXECUTE')
  and has_function_privilege('service_role',routine,'EXECUTE')),
  'all queue, owner and hydration RPCs are service-only')
from unnest(array[
  'public.seed_selection_audio_jobs(jsonb)','public.claim_selection_audio_job()',
  'public.selection_audio_job_owners(text,text)',
  'public.checkpoint_selection_audio_job(text,text,uuid,jsonb,jsonb)',
  'public.finish_selection_audio_job(text,text,uuid,jsonb,text,boolean)',
  'public.hydrate_selection_audio_results(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])',
  'public.pending_selection_audio_hydrations(integer)','public.ack_selection_audio_hydration(text,text)'
]) routine;
select extensions.ok(public.selection_audio_tracks_complete('[{"index":1,"language":"spa"}]'),
  'container language aliases count as known languages');
select extensions.ok(not coalesce(public.selection_audio_tracks_complete('[{"index":1,"lang":"und"}]'),false)
  and not coalesce(public.selection_audio_tracks_complete('[]'),false)
  and not coalesce(public.selection_audio_tracks_complete(null),false),
  'undefined language and absent probes remain unknown');
select extensions.ok(not public.selection_audio_tracks_complete('[{"index":1,"lang":"pt"},{"index":2,"lang":null}]'),
  'a partially identified multi-track file still needs analysis');

set local role service_role;
select extensions.throws_ok($$select public.seed_selection_audio_jobs('{}')$$,'22023',
  'A bounded Selection manifest is required','manifest must be an array');
select extensions.throws_ok($$select public.seed_selection_audio_jobs(
  (select jsonb_agg('{}'::jsonb) from generate_series(1,251)))$$,'22023',
  'A bounded Selection manifest is required','manifest batch is limited to 250 files');
select extensions.throws_ok($$select public.seed_selection_audio_jobs('[{"externalId":"provider:1","urlSha256":"invalid"}]')$$,
  '22023','Invalid Selection manifest identity','provider ids cannot enter the Selection queue');
select extensions.is(public.seed_selection_audio_jobs(jsonb_build_array(jsonb_build_object(
  'externalId','norva-selection:movie:'||repeat('a',64),'urlSha256',repeat('b',64)))),0,
  'a manifest with no current canonical Selection owner is not enqueued');
select extensions.is(public.selection_audio_job_owners('norva-selection:movie:'||repeat('a',64),repeat('b',64)),
  '[]'::jsonb,'no inactive or fabricated owner is returned');
reset role;

-- A fabricated queue row has no source membership and cannot be claimed.
insert into public.catalog_selection_audio_jobs(external_id,url_sha256,priority)
  values('norva-selection:movie:'||repeat('a',64),repeat('b',64),1000);
set local role service_role;
select extensions.is(public.claim_selection_audio_job(),null::jsonb,
  'claim rechecks current exact-file ownership');
reset role;

-- Running fixtures exercise durable compare-and-swap without network probes.
update public.catalog_selection_audio_jobs set state='running',attempt_count=1,
  lease_token='99100000-0000-4000-8000-000000000001',lease_until=clock_timestamp()+interval '1 minute'
  where external_id='norva-selection:movie:'||repeat('a',64) and url_sha256=repeat('b',64);
set local role service_role;
select extensions.is(public.claim_selection_audio_job(),null::jsonb,
  'an active lease prevents concurrent admission for another file');
select extensions.ok(not public.checkpoint_selection_audio_job('norva-selection:movie:'||repeat('a',64),repeat('b',64),
  '99100000-0000-4000-8000-000000000002','{}','{}'),'an obsolete worker cannot checkpoint another lease');
select extensions.ok(public.checkpoint_selection_audio_job('norva-selection:movie:'||repeat('a',64),repeat('b',64),
  '99100000-0000-4000-8000-000000000001','{"fingerprint":"fixture"}','{"nextTrack":1}'),
  'the current worker can persist progress and renew its lease');
select extensions.ok((select progress->>'nextTrack'='1' and lease_until>clock_timestamp()+interval '4 minutes'
  from public.catalog_selection_audio_jobs where external_id='norva-selection:movie:'||repeat('a',64)),
  'the checkpoint survives independently from worker memory');
select extensions.throws_ok($$select public.finish_selection_audio_job(
  'norva-selection:movie:'||repeat('a',64),repeat('b',64),'99100000-0000-4000-8000-000000000001',
  jsonb_build_object('audioTracks','[{"index":1,"lang":null}]'::jsonb,'subtitleTracks','[]'::jsonb,
    'verified',false,'verification',jsonb_build_object('status','probed','urlSha256',repeat('c',64))))$$,
  '22023','Invalid exact-file Selection audio result','a result for another URL digest is rejected');
select extensions.throws_ok($$select public.finish_selection_audio_job(
  'norva-selection:movie:'||repeat('a',64),repeat('b',64),'99100000-0000-4000-8000-000000000001',
  jsonb_build_object('audioTracks','[{"index":1,"lang":"es"}]'::jsonb,'subtitleTracks','[]'::jsonb,
    'verified',true,'verification',jsonb_build_object('status','verified','method','selection-strict-lid-v1',
      'urlSha256',repeat('b',64),'profileFingerprint','fixture','tracks','[]'::jsonb)))$$,
  '22023','Incomplete strict Selection evidence','a language tag alone cannot become a strict verification');
select extensions.ok(public.finish_selection_audio_job(
  'norva-selection:movie:'||repeat('a',64),repeat('b',64),'99100000-0000-4000-8000-000000000001',
  jsonb_build_object('audioTracks','[{"index":1,"lang":null}]'::jsonb,'subtitleTracks','[]'::jsonb,
    'verified',false,'verification',jsonb_build_object('status','probed','urlSha256',repeat('b',64)))),
  'an inconclusive analysis may finish without inventing a language');
select extensions.ok((select state='completed' and hydration_pending and not (result->>'verified')::boolean
  and result->'audioTracks'->0->>'lang' is null from public.catalog_selection_audio_jobs
  where external_id='norva-selection:movie:'||repeat('a',64)),
  'an unknown completed result is durable and awaits publication, not another audio attempt');
select extensions.is(jsonb_array_length(public.pending_selection_audio_hydrations(20)),1,
  'finished results are discoverable for publication retries');
select extensions.ok(public.ack_selection_audio_hydration('norva-selection:movie:'||repeat('a',64),repeat('b',64)),
  'successful publication can be acknowledged');
select extensions.is(public.pending_selection_audio_hydrations(20),'[]'::jsonb,
  'acknowledged publication no longer blocks later results');
select extensions.ok(not public.finish_selection_audio_job('norva-selection:movie:'||repeat('a',64),repeat('b',64),
  '99100000-0000-4000-8000-000000000001','{}','LATE_ERROR',true),
  'a late failure cannot erase a completed analysis');
reset role;

insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,attempt_count,lease_token,lease_until)
  values('norva-selection:movie:'||repeat('c',64),repeat('d',64),'running',1,
    '99100000-0000-4000-8000-000000000003',clock_timestamp()+interval '5 minutes');
set local role service_role;
select extensions.ok(public.finish_selection_audio_job('norva-selection:movie:'||repeat('c',64),repeat('d',64),
  '99100000-0000-4000-8000-000000000003','{}','GATEWAY_TEMPORARY',true),
  'retryable failures release the lease and keep the durable job');
select extensions.ok((select state='retry_wait' and next_attempt_at>=clock_timestamp()+interval '4 minutes'
  and completed_at is null and lease_token is null from public.catalog_selection_audio_jobs
  where external_id='norva-selection:movie:'||repeat('c',64)),
  'a transient failure backs off instead of spinning');
reset role;
update public.catalog_selection_audio_jobs set state='running',attempt_count=8,
  lease_token='99100000-0000-4000-8000-000000000004',lease_until=clock_timestamp()-interval '1 second'
  where external_id='norva-selection:movie:'||repeat('c',64);
set local role service_role;
select extensions.ok(not public.checkpoint_selection_audio_job('norva-selection:movie:'||repeat('c',64),repeat('d',64),
  '99100000-0000-4000-8000-000000000004','{}','{}'),'expired lease cannot be renewed by an old worker');
select extensions.is(public.claim_selection_audio_job(),null::jsonb,'an exhausted job is never claimed again');
select extensions.ok((select state='failed' and error_code='ATTEMPT_LIMIT' and completed_at is not null
  from public.catalog_selection_audio_jobs where external_id='norva-selection:movie:'||repeat('c',64)),
  'eight abandoned attempts terminate explicitly');
reset role;

insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,attempt_count,lease_token,lease_until,profile)
  values('norva-selection:movie:'||repeat('e',64),repeat('f',64),'running',1,
    '99100000-0000-4000-8000-000000000005',clock_timestamp()+interval '5 minutes',
    jsonb_build_object('fingerprint','fixture-profile','urlSha256',repeat('f',64),'audioTracks','[{"index":1,"lang":null}]'::jsonb));
set local role service_role;
select extensions.ok(public.finish_selection_audio_job(
  'norva-selection:movie:'||repeat('e',64),repeat('f',64),'99100000-0000-4000-8000-000000000005',
  jsonb_build_object('audioTracks','[{"index":1,"lang":"es"}]'::jsonb,'subtitleTracks','[]'::jsonb,
    'verified',true,'verification',jsonb_build_object('status','verified','method','selection-strict-lid-v1',
      'urlSha256',repeat('f',64),'profileFingerprint','fixture-profile','tracks',jsonb_build_array(jsonb_build_object(
        'index',1,'evidence',jsonb_build_object('method','whisper-strict-consensus-v4','streamIndex',1,
          'language','es','consensus',4,'independentWindows',4,'rejectedSpeechSampleCount',0,
          'minSampleProbability',0.99,'minSampleWordCount',12,'minSampleUniqueWordCount',8,
          'profileFingerprint','fixture-profile','samples',(select jsonb_agg(jsonb_build_object(
            'offset',sample*20,'language','es','probability',0.99,'wordCount',12,'uniqueWordCount',8))
            from generate_series(0,3) sample))))))),
  'a complete gateway-shaped certificate can finalize the checkpointed exact profile');
select extensions.ok((select (result->>'verified')::boolean and state='completed' from public.catalog_selection_audio_jobs
  where external_id='norva-selection:movie:'||repeat('e',64)),
  'strict evidence remains explicitly distinct from a container probe');
reset role;

select extensions.ok(pg_get_functiondef('public.hydrate_selection_audio_results(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])'::regprocedure)
  like '%for share of head,lifecycle%' and
  pg_get_functiondef('public.hydrate_selection_audio_results(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])'::regprocedure)
  like '%hydrate_cloud_title_file_languages%',
  'publication retains the lifecycle locks and uses the existing generation-fenced exact-file writer');
select * from extensions.finish();
rollback;
