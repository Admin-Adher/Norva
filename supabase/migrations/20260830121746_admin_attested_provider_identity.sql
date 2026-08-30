-- Allow an administrator to attest a genuinely small Xtream source without
-- weakening the automatic 32-signal trust threshold. The resulting identity
-- is source-local: it has no similarity sample, never populates the shared
-- provider-key alias, and therefore cannot attract another account/source.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

alter table public.catalog_source_provider_identities
  add column if not exists verification_method text not null default 'automatic';

alter table public.catalog_source_provider_identities
  drop constraint if exists catalog_source_provider_identities_verification_method_check;
alter table public.catalog_source_provider_identities
  add constraint catalog_source_provider_identities_verification_method_check
  check (verification_method in ('automatic', 'admin_attested_source_local'));

comment on column public.catalog_source_provider_identities.verification_method is
  'automatic requires the resolver trust threshold; admin_attested_source_local is an audited one-source identity that never seeds provider-key or similarity fanout.';

-- Preserve the historical sync signature. A manually attested source remains
-- verified on later syncs, but its identity is deliberately not copied into
-- catalog_provider_identities: that registry is the cross-source alias path.
create or replace function public.norva_resolve_provider_identity(
  p_source_id uuid,
  p_provider_key text,
  p_display_name text,
  p_status text default 'active'
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_source_name text;
  v_provider_key text;
  v_display_name text;
  v_status text;
  v_sample text[];
  v_size integer := 0;
  v_identity uuid;
  v_verification_method text := 'automatic';
  v_best_id uuid;
  v_best_jac numeric := 0;
  v_min_sample constant integer := 32;
  v_threshold constant numeric := 0.5;
  v_inter integer;
  v_union integer;
  v_jac numeric;
  rec record;
begin
  if p_source_id is null or coalesce(btrim(p_provider_key), '') = '' then
    raise exception 'invalid provider identity input' using errcode = '22023';
  end if;

  v_provider_key := left(btrim(p_provider_key), 500);
  v_status := case when p_status in ('active', 'deleted') then p_status else 'active' end;

  select source.user_id, source.display_name::text
    into v_user_id, v_source_name
  from public.cloud_sources source
  where source.id = p_source_id
    and source.source_type = 'xtream'
    and source.deleted_at is null
  for share;

  if not found then
    raise exception 'provider source unavailable' using errcode = 'P0002';
  end if;

  v_display_name := left(
    coalesce(nullif(btrim(p_display_name), ''), nullif(btrim(v_source_name), ''), v_provider_key),
    200
  );

  select link.identity_id, link.verification_method
    into v_identity, v_verification_method
  from public.catalog_source_provider_identities link
  where link.source_id = p_source_id
    and link.user_id = v_user_id
  for share;

  if v_identity is not null then
    if v_verification_method = 'automatic' then
      insert into public.catalog_provider_identities as alias (
        provider_key, display_name, status, identity_id, last_seen, updated_at
      ) values (
        v_provider_key, v_display_name, v_status, v_identity,
        clock_timestamp(), clock_timestamp()
      )
      on conflict (provider_key) do update
        set display_name = excluded.display_name,
            status = excluded.status,
            identity_id = excluded.identity_id,
            last_seen = excluded.last_seen,
            updated_at = excluded.updated_at;
    else
      insert into public.catalog_provider_identities as alias (
        provider_key, display_name, status, last_seen, updated_at
      ) values (
        v_provider_key, v_display_name, v_status,
        clock_timestamp(), clock_timestamp()
      )
      on conflict (provider_key) do update
        set display_name = excluded.display_name,
            status = excluded.status,
            last_seen = excluded.last_seen,
            updated_at = excluded.updated_at;
    end if;

    update public.catalog_source_provider_identities link
       set provider_key = v_provider_key,
           updated_at = clock_timestamp()
     where link.source_id = p_source_id
       and link.user_id = v_user_id;
    update public.provider_identities identity
       set last_seen = clock_timestamp(), updated_at = clock_timestamp()
     where identity.id = v_identity;
    delete from public.catalog_source_provider_identity_candidates candidate
     where candidate.source_id = p_source_id
       and candidate.user_id = v_user_id;
    return v_identity;
  end if;

  select array_agg(sample.external_id order by sample.external_id)
    into v_sample
  from (
    select distinct_item.external_id
    from (
      select distinct item.external_id
      from public.cloud_media_items item
      where item.source_id = p_source_id
        and item.user_id = v_user_id
        and item.item_type in ('movie', 'series')
        and item.available = true
        and coalesce(btrim(item.external_id), '') <> ''
    ) distinct_item
    order by md5(distinct_item.external_id)
    limit 256
  ) sample;
  v_size := coalesce(cardinality(v_sample), 0);

  insert into public.catalog_provider_identities as alias (
    provider_key, display_name, status, last_seen, updated_at
  ) values (
    v_provider_key, v_display_name, v_status,
    clock_timestamp(), clock_timestamp()
  )
  on conflict (provider_key) do update
    set display_name = excluded.display_name,
        status = excluded.status,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at;

  if v_size < v_min_sample then
    insert into public.catalog_source_provider_identity_candidates as candidate (
      source_id, user_id, provider_key, display_name, resolution_state,
      evidence_count, required_evidence, sample_kind,
      first_seen_at, last_attempt_at, updated_at
    ) values (
      p_source_id, v_user_id, v_provider_key, v_display_name, 'provisional',
      v_size, v_min_sample, 'xtream-streamid-md5-bottom256',
      clock_timestamp(), clock_timestamp(), clock_timestamp()
    )
    on conflict (source_id) do update
      set user_id = excluded.user_id,
          provider_key = excluded.provider_key,
          display_name = excluded.display_name,
          resolution_state = 'provisional',
          evidence_count = excluded.evidence_count,
          required_evidence = excluded.required_evidence,
          sample_kind = excluded.sample_kind,
          last_attempt_at = excluded.last_attempt_at,
          updated_at = excluded.updated_at;
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('norva_provider_identity_resolve')
  );

  select link.identity_id
    into v_identity
  from public.catalog_source_provider_identities link
  where link.source_id = p_source_id
    and link.user_id = v_user_id
  for share;

  if v_identity is null then
    select alias.identity_id
      into v_identity
    from public.catalog_provider_identities alias
    where alias.provider_key = v_provider_key;
  end if;

  if v_identity is null then
    for rec in
      select identity.id, identity.stream_sample
      from public.provider_identities identity
      where identity.status = 'active'
        and identity.stream_sample && v_sample
    loop
      select
        cardinality(array(
          select value from pg_catalog.unnest(rec.stream_sample) value
          intersect
          select value from pg_catalog.unnest(v_sample) value
        )),
        cardinality(array(
          select value from pg_catalog.unnest(rec.stream_sample) value
          union
          select value from pg_catalog.unnest(v_sample) value
        ))
        into v_inter, v_union;
      v_jac := case when v_union > 0 then v_inter::numeric / v_union else 0 end;
      if v_jac > v_best_jac then
        v_best_jac := v_jac;
        v_best_id := rec.id;
      end if;
    end loop;

    if v_best_id is not null and v_best_jac >= v_threshold then
      v_identity := v_best_id;
      update public.provider_identities identity
         set last_seen = clock_timestamp(),
             updated_at = clock_timestamp(),
             display_name = coalesce(identity.display_name, v_display_name)
       where identity.id = v_identity;
    else
      insert into public.provider_identities (
        display_name, status, stream_sample, sample_kind,
        first_seen, last_seen, created_at, updated_at
      ) values (
        v_display_name, v_status, v_sample,
        'xtream-streamid-md5-bottom256',
        clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp()
      ) returning id into v_identity;
    end if;
  else
    update public.provider_identities identity
       set last_seen = clock_timestamp(), updated_at = clock_timestamp()
     where identity.id = v_identity;
  end if;

  update public.catalog_provider_identities alias
     set identity_id = v_identity,
         updated_at = clock_timestamp()
   where alias.provider_key = v_provider_key;

  insert into public.catalog_source_provider_identities as link (
    source_id, user_id, identity_id, provider_key, verification_method,
    verified_at, updated_at
  ) values (
    p_source_id, v_user_id, v_identity, v_provider_key, 'automatic',
    clock_timestamp(), clock_timestamp()
  )
  on conflict (source_id) do update
    set user_id = excluded.user_id,
        identity_id = excluded.identity_id,
        provider_key = excluded.provider_key,
        verification_method = 'automatic',
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at;

  delete from public.catalog_source_provider_identity_candidates candidate
   where candidate.source_id = p_source_id
     and candidate.user_id = v_user_id;

  return v_identity;
end
$function$;

revoke all on function public.norva_resolve_provider_identity(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.norva_resolve_provider_identity(uuid, text, text, text)
  to service_role;

create or replace function public.admin_attest_source_provider_identity(
  p_source_id uuid,
  p_reason text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source public.cloud_sources%rowtype;
  v_candidate public.catalog_source_provider_identity_candidates%rowtype;
  v_existing_identity uuid;
  v_existing_method text;
  v_existing_name text;
  v_alias_identity uuid;
  v_identity uuid;
  v_identity_name text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_actor text := nullif(auth.jwt() ->> 'email', '');
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_source_id is null then
    raise exception 'source required' using errcode = '22023';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'reason must contain 3 to 500 characters' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('norva_provider_identity_resolve')
  );

  select source.*
    into v_source
  from public.cloud_sources source
  where source.id = p_source_id
  for update;

  if not found or v_source.deleted_at is not null then
    raise exception 'provider source unavailable' using errcode = 'P0002';
  end if;
  if v_source.source_type <> 'xtream' or not v_source.enabled or v_source.sync_status <> 'ready' then
    raise exception 'source must be an enabled ready Xtream source' using errcode = '55000';
  end if;

  select link.identity_id, link.verification_method, identity.display_name::text
    into v_existing_identity, v_existing_method, v_existing_name
  from public.catalog_source_provider_identities link
  join public.provider_identities identity on identity.id = link.identity_id
  where link.source_id = v_source.id
    and link.user_id = v_source.user_id
  for share of link, identity;

  if v_existing_identity is not null then
    return jsonb_build_object(
      'status', 'verified',
      'already_verified', true,
      'resolution_method', coalesce(v_existing_method, 'automatic'),
      'source_name', v_source.display_name,
      'identity_name', v_existing_name,
      'cross_account_eligible', coalesce(v_existing_method, 'automatic') = 'automatic'
    );
  end if;

  select candidate.*
    into v_candidate
  from public.catalog_source_provider_identity_candidates candidate
  where candidate.source_id = v_source.id
    and candidate.user_id = v_source.user_id
  for update;

  if not found then
    raise exception 'source has no provisional provider candidate' using errcode = '55000';
  end if;
  if v_candidate.evidence_count < 1 then
    raise exception 'at least one stable signal is required for admin attestation' using errcode = '55000';
  end if;
  if v_candidate.evidence_count >= v_candidate.required_evidence then
    raise exception 'automatic resolution threshold already reached' using errcode = '55000';
  end if;

  insert into public.catalog_provider_identities as alias (
    provider_key, display_name, status, last_seen, updated_at
  ) values (
    v_candidate.provider_key,
    left(coalesce(nullif(btrim(v_candidate.display_name), ''), v_source.display_name::text), 200),
    'active', clock_timestamp(), clock_timestamp()
  )
  on conflict (provider_key) do update
    set display_name = excluded.display_name,
        status = 'active',
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at;

  select alias.identity_id
    into v_alias_identity
  from public.catalog_provider_identities alias
  where alias.provider_key = v_candidate.provider_key
  for update;

  if v_alias_identity is not null then
    raise exception 'provider fingerprint already has a canonical identity; automatic evidence or an explicit merge review is required'
      using errcode = '55000';
  end if;

  v_identity_name := left(
    coalesce(nullif(btrim(v_candidate.display_name), ''), nullif(btrim(v_source.display_name::text), ''), 'Source attestée'),
    200
  );

  insert into public.provider_identities (
    display_name, status, notes, stream_sample, sample_kind,
    first_seen, last_seen, created_at, updated_at
  ) values (
    v_identity_name,
    'active',
    'Identité attestée par un administrateur pour cette source uniquement. Aucun rapprochement automatique inter-sources.',
    array[]::text[],
    'admin-attested-source-local-v1',
    v_candidate.first_seen_at,
    clock_timestamp(), clock_timestamp(), clock_timestamp()
  ) returning id into v_identity;

  insert into public.catalog_source_provider_identities (
    source_id, user_id, identity_id, provider_key, verification_method,
    verified_at, updated_at
  ) values (
    v_source.id, v_source.user_id, v_identity, v_candidate.provider_key,
    'admin_attested_source_local', clock_timestamp(), clock_timestamp()
  );

  delete from public.catalog_source_provider_identity_candidates candidate
  where candidate.source_id = v_source.id
    and candidate.user_id = v_source.user_id;
  if not found then
    raise exception 'provisional candidate changed concurrently' using errcode = 'PT409';
  end if;

  insert into public.admin_events (user_id, kind, summary, actor, meta)
  values (
    v_source.user_id,
    'admin_action',
    'Identité provider attestée manuellement : ' || v_identity_name,
    v_actor,
    jsonb_build_object(
      'action', 'provider_identity_admin_attestation',
      'reason', v_reason,
      'status', 'completed',
      'source_id', v_source.id,
      'identity_id', v_identity,
      'evidence_count', v_candidate.evidence_count,
      'required_evidence', v_candidate.required_evidence,
      'cross_account_eligible', false
    )
  );

  return jsonb_build_object(
    'status', 'verified',
    'already_verified', false,
    'resolution_method', 'admin_attested_source_local',
    'source_name', v_source.display_name,
    'identity_name', v_identity_name,
    'evidence_count', v_candidate.evidence_count,
    'required_evidence', v_candidate.required_evidence,
    'cross_account_eligible', false
  );
end
$function$;

revoke all on function public.admin_attest_source_provider_identity(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_attest_source_provider_identity(uuid, text)
  to authenticated, service_role;

comment on function public.admin_attest_source_provider_identity(uuid, text) is
  'Admin-only audited attestation for a low-volume source. Creates a unique source-local identity and never seeds automatic provider-key or similarity fanout.';

notify pgrst, 'reload schema';
commit;
