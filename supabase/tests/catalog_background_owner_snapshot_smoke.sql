begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '94500000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','owner-snapshot-smoke@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);

insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '94500000-0000-4000-8000-000000000101',
  '94500000-0000-4000-8000-000000000001',
  'xtream','Owner snapshot A','cipher-a','{}'::jsonb,
  'ready',1,true,now()
);

do $smoke$
declare
  v_user constant uuid := '94500000-0000-4000-8000-000000000001';
  v_source constant uuid := '94500000-0000-4000-8000-000000000101';
  v_title constant uuid := '94500000-0000-4000-8000-000000000701';
  v_generation uuid;
  v_epoch bigint;
  v_begin jsonb;
  v_build jsonb;
  v_activate jsonb;
  v_page jsonb;
  v_claim jsonb;
  v_replay jsonb;
  v_ack jsonb;
  v_lease_sequence integer;
  v_checkpoint_revision bigint;
  v_payload_before text;
  v_digest_before text;
  v_old_snapshot uuid;
  v_new_snapshot uuid;
begin
  select head.active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads head
  where head.source_id = v_source and head.user_id = v_user;

  insert into public.cloud_titles (
    id,user_id,item_type,identity_key,identity_source,provider_tmdb_id,
    match_status,title,metadata,search_match_attempted_at,updated_at
  ) values (
    v_title,v_user,'movie','provider_tmdb:945','provider_tmdb','945',
    'unmatched','Owner snapshot title','{}'::jsonb,null,
    now() - interval '1 hour'
  );
  insert into public.cloud_title_variants (
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    '94500000-0000-4000-8000-000000000801',v_user,v_title,v_source,
    'movie','945','Owner snapshot title',v_generation
  );

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (v_user,1,now()) on conflict (user_id) do nothing;
  select visibility_epoch into strict v_epoch
  from public.cloud_user_catalog_visibility_epochs where user_id = v_user;

  v_begin := public.norva_begin_catalog_background_owner_snapshot(
    v_user,null,'baseline',null,null,null,v_epoch
  );
  v_build := public.norva_build_catalog_background_owner_snapshot_slice(
    (v_begin ->> 'snapshotId')::uuid,v_user,
    (v_begin ->> 'revision')::bigint,
    (v_begin ->> 'visibilityEpoch')::bigint,100
  );
  if not (v_build ->> 'complete')::boolean then
    raise exception 'owner baseline build did not complete';
  end if;
  v_activate := public.norva_activate_catalog_background_owner_baseline(
    (v_begin ->> 'snapshotId')::uuid,v_user,
    (v_build ->> 'revision')::bigint,
    (v_begin ->> 'visibilityEpoch')::bigint
  );
  v_old_snapshot := (v_activate ->> 'snapshotId')::uuid;

  v_page := public.norva_select_catalog_title_background_page_v4(
    'search_pending',10,now(),null,v_user
  );
  if (v_page ->> 'returnedTitles')::integer <> 1
     or v_page #>> '{items,0,id}' <> v_title::text then
    raise exception 'owner selector missed the exact active title';
  end if;

  -- A lost response keeps the page inflight.  If the title payload changes
  -- while it remains due, reclaim must rehydrate the current owner row and
  -- rotate the DB digest/revision; replaying the stale payloadUpdatedAt would
  -- make the exact background writer reject forever.
  select visibility_epoch into strict v_epoch
  from public.cloud_user_catalog_visibility_epochs where user_id = v_user;
  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set state = 'processing',retry_before = now(),owner_user_id = v_user,
      snapshot_id = v_old_snapshot,user_visibility_epoch = v_epoch,
      last_attempted_at = null,last_title_id = null,
      inflight_items = '[]'::jsonb,inflight_last_attempted_at = null,
      inflight_last_title_id = null,inflight_owner_exhausted = false,
      inflight_byte_count = 0,
      lease_sequence = checkpoint.lease_sequence + 1,
      lease_owner = 'owner-snapshot-smoke',lease_until = now() + interval '2 minutes',
      revision = checkpoint.revision + 1,updated_at = now()
  where checkpoint.mode = 'search_pending'
  returning lease_sequence,revision
    into strict v_lease_sequence,v_checkpoint_revision;
  v_claim := public.norva_select_catalog_title_background_claim_page(
    'search_pending','owner-snapshot-smoke',v_lease_sequence,
    v_checkpoint_revision,10
  );
  if (v_claim ->> 'returnedTitles')::integer <> 1
     or not (v_claim ->> 'ackRequired')::boolean then
    raise exception 'owner inflight fixture did not pin one due title';
  end if;
  v_payload_before := v_claim #>> '{items,0,payloadUpdatedAt}';
  v_digest_before := v_claim ->> 'pageDigest';

  update public.cloud_titles
  set title = 'Owner snapshot title V2',
      metadata = jsonb_build_object('replay','v2'),
      updated_at = clock_timestamp()
  where id = v_title and user_id = v_user;
  -- norva_set_updated_at uses transaction_timestamp(), so this rollback-only
  -- fixture advances the private owner timestamp explicitly to model the
  -- later transaction that races a real lost-response replay.
  update public.cloud_catalog_background_owner_snapshot_rows owner_row
  set catalog_metadata = jsonb_build_object('replay','v2'),
      payload_updated_at = clock_timestamp(),updated_at = clock_timestamp()
  where owner_row.snapshot_id = v_old_snapshot
    and owner_row.title_id = v_title;
  v_replay := public.norva_select_catalog_title_background_claim_page(
    'search_pending','owner-snapshot-smoke',v_lease_sequence,
    (v_claim ->> 'checkpointRevision')::bigint,10
  );
  if (v_replay ->> 'returnedTitles')::integer <> 1
     or not (v_replay ->> 'replayed')::boolean
     or not (v_replay ->> 'outcomeReconciled')::boolean
     or v_replay #>> '{items,0,title}' <> 'Owner snapshot title V2'
     or v_replay #>> '{items,0,metadata,replay}' <> 'v2'
     or v_replay #>> '{items,0,payloadUpdatedAt}' = v_payload_before
     or v_replay ->> 'pageDigest' = v_digest_before then
    raise exception 'owner inflight replay did not rehydrate current payload';
  end if;

  update public.cloud_titles
  set search_match_attempted_at = now(),updated_at = clock_timestamp()
  where id = v_title and user_id = v_user;
  v_ack := public.norva_ack_catalog_title_background_claim_page(
    'search_pending','owner-snapshot-smoke',v_lease_sequence,
    (v_replay ->> 'checkpointRevision')::bigint,
    v_replay ->> 'pageDigest',array[v_title]
  );
  if (v_ack ->> 'acknowledgedTitles')::integer <> 1
     or (v_ack ->> 'remainingTitles')::integer <> 0 then
    raise exception 'owner rehydrated inflight outcome did not advance';
  end if;
  update public.cloud_titles
  set search_match_attempted_at = null,updated_at = clock_timestamp()
  where id = v_title and user_id = v_user;

  delete from public.cloud_title_variants
  where id = '94500000-0000-4000-8000-000000000801';
  if not exists (
    select 1 from public.cloud_catalog_background_owner_snapshot_rows row_state
    where row_state.snapshot_id = v_old_snapshot
      and row_state.title_id = v_title and not row_state.is_present
  ) then
    raise exception 'owner deletion tombstone was not retained';
  end if;
  v_page := public.norva_select_catalog_title_background_page_v4(
    'search_pending',10,now(),null,v_user
  );
  if (v_page ->> 'returnedTitles')::integer <> 0 then
    raise exception 'owner tombstone leaked through due selector';
  end if;

  insert into public.cloud_title_variants (
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    '94500000-0000-4000-8000-000000000802',v_user,v_title,v_source,
    'movie','945','Owner snapshot title',v_generation
  );
  if not exists (
    select 1 from public.cloud_catalog_background_owner_snapshot_rows row_state
    where row_state.snapshot_id = v_old_snapshot
      and row_state.title_id = v_title and row_state.is_present
  ) then
    raise exception 'owner title did not recover from its tombstone';
  end if;

  -- A source created after activation is a topology change.  It must fail the
  -- old pointer closed until a bounded replacement baseline is activated.
  insert into public.cloud_sources (
    id,user_id,source_type,display_name,config_ciphertext,config_hint,
    sync_status,catalog_version,enabled,last_synced_at
  ) values (
    '94500000-0000-4000-8000-000000000102',v_user,'xtream',
    'Owner snapshot C','cipher-c','{}'::jsonb,'ready',1,true,now()
  );
  begin
    perform public.norva_select_catalog_title_background_page_v4(
      'search_pending',10,now(),null,v_user
    );
    raise exception 'stale topology selector unexpectedly succeeded';
  exception when serialization_failure then
    null;
  end;

  select visibility_epoch into strict v_epoch
  from public.cloud_user_catalog_visibility_epochs where user_id = v_user;
  v_begin := public.norva_begin_catalog_background_owner_snapshot(
    v_user,null,'baseline',null,null,null,v_epoch
  );
  v_build := public.norva_build_catalog_background_owner_snapshot_slice(
    (v_begin ->> 'snapshotId')::uuid,v_user,
    (v_begin ->> 'revision')::bigint,
    (v_begin ->> 'visibilityEpoch')::bigint,100
  );
  v_activate := public.norva_activate_catalog_background_owner_baseline(
    (v_begin ->> 'snapshotId')::uuid,v_user,
    (v_build ->> 'revision')::bigint,
    (v_begin ->> 'visibilityEpoch')::bigint
  );
  v_new_snapshot := (v_activate ->> 'snapshotId')::uuid;
  if v_new_snapshot = v_old_snapshot
     or not exists (
       select 1 from public.cloud_catalog_background_owner_snapshots snapshot
       where snapshot.id = v_old_snapshot and snapshot.state = 'purging'
     ) then
    raise exception 'stale baseline was not atomically replaced';
  end if;
  v_page := public.norva_select_catalog_title_background_page_v4(
    'search_pending',10,now(),null,v_user
  );
  if (v_page ->> 'returnedTitles')::integer <> 1 then
    raise exception 'replacement owner baseline is not readable';
  end if;
end
$smoke$;

rollback;
