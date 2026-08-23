begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

create or replace function public.norva_seal_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer,
  p_expected_transition_revision bigint,
  p_expected_generation_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '60s'
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_candidate public.cloud_source_catalog_generations%rowtype;
  v_previous public.cloud_source_catalog_generations%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_progress public.cloud_source_catalog_manifest_seal_progress%rowtype;
  v_candidate_progress public.cloud_source_catalog_manifest_seal_progress%rowtype;
  v_previous_progress public.cloud_source_catalog_manifest_seal_progress%rowtype;
  v_candidate_manifest jsonb;
  v_previous_manifest jsonb;
  -- Benchmarked bounded page: small enough to avoid temp spill on the normal
  -- path, large enough that a million-row manifest does not need thousands of
  -- job claims.  The Edge worker may execute several pages under one lease.
  v_limit integer := 25000;
  v_processed integer := 0;
  v_next_a text;
  v_next_b text;
  v_next_c text;
  v_next_id uuid;
  v_page_sum_0 numeric := 0;
  v_page_sum_1 numeric := 0;
  v_page_sum_2 numeric := 0;
  v_page_sum_3 numeric := 0;
  v_page_xor_0 bigint := 0;
  v_page_xor_1 bigint := 0;
  v_page_xor_2 bigint := 0;
  v_page_xor_3 bigint := 0;
  v_page_live bigint := 0;
  v_page_movie bigint := 0;
  v_page_series bigint := 0;
  v_page_sample jsonb := '[]'::jsonb;
  v_merged_sample jsonb := '[]'::jsonb;
  v_page_strong_sample text[] := '{}'::text[];
  v_merged_strong_sample text[] := '{}'::text[];
  v_next_phase text;
  v_all_complete boolean := false;
  v_candidate_revision bigint;
  v_fenced_generations integer := 0;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  perform set_config('lock_timeout', '2s', true);

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found or v_transition.state <> 'importing'
     or v_transition.revision <> p_expected_transition_revision
     or v_transition.candidate_catalog_generation_id <> p_generation_id then
    raise exception 'candidate generation seal transition CAS failed'
      using errcode = '40001';
  end if;

  select generation.* into v_candidate
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.transition_id = p_transition_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id
  for update;
  if not found or v_candidate.state <> 'building'
     or v_candidate.revision <> p_expected_generation_revision then
    raise exception 'candidate generation seal CAS failed'
      using errcode = '40001';
  end if;

  select generation.* into v_previous
  from public.cloud_source_catalog_generations generation
  join public.cloud_source_catalog_heads head
    on head.source_id = generation.source_id
   and head.user_id = generation.user_id
   and head.active_generation_id = generation.id
  where generation.id = v_transition.previous_catalog_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = v_transition.old_source_id
  for update of generation;
  if not found or v_previous.state <> 'active' then
    raise exception 'previous active generation seal CAS failed'
      using errcode = '40001';
  end if;

  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
  for update;
  if not found or v_job.job_kind <> 'build_candidate_generation'
     or v_job.state <> 'processing' or v_job.lease_owner <> p_worker
     or v_job.lease_sequence <> p_expected_attempt
     or v_job.lease_until <= now() then
    raise exception 'candidate generation seal lease CAS failed'
      using errcode = '40001';
  end if;

  if not v_candidate.manifest_sealing then
    if v_previous.manifest_sealing then
      raise exception 'previous generation is already sealed by another workflow'
        using errcode = '55P03';
    end if;
    if coalesce(v_job.progress ->> 'action','') <> 'complete'
       or coalesce((v_job.progress ->> 'categoriesDone')::boolean, false)
          is not true
       or (
         select count(*)
         from public.cloud_source_catalog_generation_category_lists list
         where list.generation_id = p_generation_id and list.listing_complete
       ) <> 3
       or (
         select count(*)
         from public.cloud_source_catalog_generation_inventory_actions action
         where action.generation_id = p_generation_id and action.action_complete
       ) <> 3
       or not exists (
         select 1
         from public.cloud_source_catalog_generation_episode_copy copy
         where copy.generation_id = p_generation_id and copy.state = 'complete'
       ) then
      raise exception 'candidate generation completeness ledger is incomplete'
        using errcode = '55000';
    end if;

    -- Fence both snapshots before the first page.  Physical statement triggers
    -- CAS this flag against the same generation row, closing the pre-fence
    -- writer race without holding table locks across RPC calls.
    update public.cloud_source_catalog_generations generation
    set manifest_sealing = true,
        manifest_counts = '{}'::jsonb,
        manifest_checksum = null,
        identity_evidence = '{}'::jsonb,
        revision = generation.revision + 1,
        updated_at = clock_timestamp()
    where generation.id in (v_candidate.id, v_previous.id)
      and not generation.manifest_sealing;
    get diagnostics v_fenced_generations = row_count;
    if v_fenced_generations <> 2 then
      raise exception 'catalog manifest fence CAS failed' using errcode = '40001';
    end if;
    select generation.* into v_candidate
    from public.cloud_source_catalog_generations generation
    where generation.id = p_generation_id;
    select generation.* into v_previous
    from public.cloud_source_catalog_generations generation
    where generation.id = v_transition.previous_catalog_generation_id;

    insert into public.cloud_source_catalog_manifest_seal_progress (
      generation_id, user_id, source_id, seal_transition_id, seal_role,
      snapshot_revision
    ) values (
      v_previous.id, p_user_id, v_previous.source_id, p_transition_id,
      'previous', v_previous.revision
    )
    on conflict (generation_id) do update set
      user_id = excluded.user_id, source_id = excluded.source_id,
      seal_transition_id = excluded.seal_transition_id,
      seal_role = excluded.seal_role, phase = 'media_items',
      cursor_a = null, cursor_b = null, cursor_c = null, cursor_id = null,
      media_items_count = 0, title_variants_count = 0,
      live_channels_count = 0, live_variants_count = 0,
      episode_memberships_count = 0, series_inventory_count = 0,
      live_items_count = 0, movie_items_count = 0, series_items_count = 0,
      lane_sum_0 = 0, lane_sum_1 = 0, lane_sum_2 = 0, lane_sum_3 = 0,
      lane_xor_0 = 0, lane_xor_1 = 0, lane_xor_2 = 0, lane_xor_3 = 0,
      identity_sample = '[]'::jsonb,
      strong_identity_sample = '{}'::text[],
      snapshot_revision = excluded.snapshot_revision,
      processed_rows = 0, started_at = clock_timestamp(),
      completed_at = null, updated_at = clock_timestamp();
    insert into public.cloud_source_catalog_manifest_seal_progress (
      generation_id, user_id, source_id, seal_transition_id, seal_role,
      snapshot_revision
    ) values (
      v_candidate.id, p_user_id, v_candidate.source_id, p_transition_id,
      'candidate', v_candidate.revision
    )
    on conflict (generation_id) do update set
      user_id = excluded.user_id, source_id = excluded.source_id,
      seal_transition_id = excluded.seal_transition_id,
      seal_role = excluded.seal_role, phase = 'media_items',
      cursor_a = null, cursor_b = null, cursor_c = null, cursor_id = null,
      media_items_count = 0, title_variants_count = 0,
      live_channels_count = 0, live_variants_count = 0,
      episode_memberships_count = 0, series_inventory_count = 0,
      live_items_count = 0, movie_items_count = 0, series_items_count = 0,
      lane_sum_0 = 0, lane_sum_1 = 0, lane_sum_2 = 0, lane_sum_3 = 0,
      lane_xor_0 = 0, lane_xor_1 = 0, lane_xor_2 = 0, lane_xor_3 = 0,
      identity_sample = '[]'::jsonb,
      strong_identity_sample = '{}'::text[],
      snapshot_revision = excluded.snapshot_revision,
      processed_rows = 0, started_at = clock_timestamp(),
      completed_at = null, updated_at = clock_timestamp();
  elsif not v_previous.manifest_sealing
     or not exists (
       select 1
       from public.cloud_source_catalog_manifest_seal_progress progress
       join public.cloud_source_catalog_generations generation
         on generation.id = progress.generation_id
        and generation.user_id = progress.user_id
        and generation.source_id = progress.source_id
        and generation.revision = progress.snapshot_revision
        and generation.manifest_sealing
       where progress.seal_transition_id = p_transition_id
       group by progress.seal_transition_id
       having count(*) = 2
     ) then
    raise exception 'catalog manifest seal continuation drifted'
      using errcode = '40001';
  end if;

  select progress.* into v_progress
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.seal_transition_id = p_transition_id
    and progress.phase <> 'complete'
  order by case progress.seal_role when 'previous' then 0 else 1 end
  limit 1
  for update;

  if found then
    if v_progress.phase = 'media_items' then
      with page as materialized (
        select item.id, item.item_type, item.external_id,
               item.parent_external_id, item.title
        from public.cloud_media_items item
        where item.source_id = v_progress.source_id
          and item.user_id = v_progress.user_id
          and item.generation_id = v_progress.generation_id
          and (
            v_progress.cursor_a is null
            or (item.item_type, item.external_id, item.id) >
               (v_progress.cursor_a, v_progress.cursor_b,
                v_progress.cursor_id)
          )
        order by item.item_type, item.external_id, item.id
        limit v_limit
      ), row_hashes as materialized (
        select page.*,
          extensions.digest(jsonb_build_array(
            'media', page.item_type, page.external_id,
            page.parent_external_id, page.title
          )::text, 'sha256') as row_hash
        from page
      ), lanes as (
        select row_hashes.*,
          ('x'||substr(encode(row_hash,'hex'),1,16))::bit(64)::bigint l0,
          ('x'||substr(encode(row_hash,'hex'),17,16))::bit(64)::bigint l1,
          ('x'||substr(encode(row_hash,'hex'),33,16))::bit(64)::bigint l2,
          ('x'||substr(encode(row_hash,'hex'),49,16))::bit(64)::bigint l3
        from row_hashes
      )
      select count(*)::integer,
        (array_agg(item_type order by item_type desc, external_id desc,
          id desc))[1],
        (array_agg(external_id order by item_type desc, external_id desc,
          id desc))[1],
        (array_agg(id order by item_type desc, external_id desc, id desc))[1],
        coalesce(sum(l0::numeric),0), coalesce(bit_xor(l0),0),
        coalesce(sum(l1::numeric),0), coalesce(bit_xor(l1),0),
        coalesce(sum(l2::numeric),0), coalesce(bit_xor(l2),0),
        coalesce(sum(l3::numeric),0), coalesce(bit_xor(l3),0),
        count(*) filter (where item_type='live'),
        count(*) filter (where item_type='movie'),
        count(*) filter (where item_type='series'),
        (
          select coalesce(jsonb_agg(jsonb_build_object(
            'orderHash', sample.order_hash,
            'itemType', sample.item_type,
            'externalIdHash', sample.external_id_hash
          ) order by sample.order_hash, sample.item_type,
            sample.external_id_hash), '[]'::jsonb)
          from (
            select md5(page.item_type||':'||page.external_id) order_hash,
              page.item_type,
              encode(extensions.digest(
                page.item_type||':'||page.external_id,'sha256'
              ),'hex') external_id_hash
            from page
            where page.item_type in ('movie','series')
            order by md5(page.item_type||':'||page.external_id),
              page.item_type, page.external_id
            limit 256
          ) sample
        ),
        (
          select coalesce(array_agg(sample.external_id order by
            sample.order_hash, sample.external_id), '{}'::text[])
          from (
            select page.external_id, md5(page.external_id) order_hash
            from page
            where page.item_type in ('movie','series')
              and coalesce(page.external_id, '') <> ''
              and octet_length(page.external_id) <= 128
            order by md5(page.external_id), page.external_id
            limit 256
          ) sample
        )
      into v_processed, v_next_a, v_next_b, v_next_id,
        v_page_sum_0, v_page_xor_0, v_page_sum_1, v_page_xor_1,
        v_page_sum_2, v_page_xor_2, v_page_sum_3, v_page_xor_3,
        v_page_live, v_page_movie, v_page_series, v_page_sample,
        v_page_strong_sample
      from lanes;

      select coalesce(jsonb_agg(jsonb_build_object(
        'orderHash', merged.order_hash,
        'itemType', merged.item_type,
        'externalIdHash', merged.external_id_hash
      ) order by merged.order_hash, merged.item_type,
        merged.external_id_hash), '[]'::jsonb)
      into v_merged_sample
      from (
        select candidate.order_hash, candidate.item_type,
               candidate.external_id_hash
        from (
          select old."orderHash", old."itemType", old."externalIdHash"
          from jsonb_to_recordset(v_progress.identity_sample) old(
            "orderHash" text, "itemType" text, "externalIdHash" text
          )
          union all
          select page."orderHash", page."itemType", page."externalIdHash"
          from jsonb_to_recordset(v_page_sample) page(
            "orderHash" text, "itemType" text, "externalIdHash" text
          )
        ) raw
        cross join lateral (select raw."orderHash", raw."itemType",
          raw."externalIdHash") candidate(
            order_hash,item_type,external_id_hash
          )
        order by candidate.order_hash, candidate.item_type,
          candidate.external_id_hash
        limit 256
      ) merged;
      select coalesce(array_agg(sample.external_id order by
        sample.order_hash, sample.external_id), '{}'::text[])
      into v_merged_strong_sample
      from (
        select raw.external_id, md5(raw.external_id) order_hash
        from (
          select unnest(v_progress.strong_identity_sample) external_id
          union
          select unnest(v_page_strong_sample) external_id
        ) raw
        where coalesce(raw.external_id, '') <> ''
        order by md5(raw.external_id), raw.external_id
        limit 256
      ) sample;
      v_next_phase := case when v_processed < v_limit
        then 'title_variants' else 'media_items' end;
      update public.cloud_source_catalog_manifest_seal_progress progress
      set media_items_count = progress.media_items_count + v_processed,
          live_items_count = progress.live_items_count + v_page_live,
          movie_items_count = progress.movie_items_count + v_page_movie,
          series_items_count = progress.series_items_count + v_page_series,
          lane_sum_0 = progress.lane_sum_0 + v_page_sum_0,
          lane_sum_1 = progress.lane_sum_1 + v_page_sum_1,
          lane_sum_2 = progress.lane_sum_2 + v_page_sum_2,
          lane_sum_3 = progress.lane_sum_3 + v_page_sum_3,
          lane_xor_0 = progress.lane_xor_0 # v_page_xor_0,
          lane_xor_1 = progress.lane_xor_1 # v_page_xor_1,
          lane_xor_2 = progress.lane_xor_2 # v_page_xor_2,
          lane_xor_3 = progress.lane_xor_3 # v_page_xor_3,
          identity_sample = v_merged_sample,
          strong_identity_sample = v_merged_strong_sample,
          phase = v_next_phase,
          cursor_a = case when v_next_phase='media_items' then v_next_a end,
          cursor_b = case when v_next_phase='media_items' then v_next_b end,
          cursor_c = null,
          cursor_id = case when v_next_phase='media_items' then v_next_id end,
          processed_rows = progress.processed_rows + v_processed,
          updated_at = clock_timestamp()
      where progress.generation_id = v_progress.generation_id;
    elsif v_progress.phase = 'title_variants' then
      with page as materialized (
        select variant.id, variant.item_type, variant.external_id
        from public.cloud_title_variants variant
        where variant.source_id=v_progress.source_id
          and variant.user_id=v_progress.user_id
          and variant.generation_id=v_progress.generation_id
          and (v_progress.cursor_a is null or
            (variant.item_type,variant.external_id,variant.id) >
            (v_progress.cursor_a,v_progress.cursor_b,v_progress.cursor_id))
        order by variant.item_type,variant.external_id,variant.id limit v_limit
      )
      select count(*)::integer,
        (array_agg(item_type order by item_type desc,external_id desc,id desc))[1],
        (array_agg(external_id order by item_type desc,external_id desc,id desc))[1],
        (array_agg(id order by item_type desc,external_id desc,id desc))[1]
      into v_processed,v_next_a,v_next_b,v_next_id from page;
      v_next_phase := case when v_processed<v_limit then 'live_channels'
        else 'title_variants' end;
      update public.cloud_source_catalog_manifest_seal_progress progress set
        title_variants_count=progress.title_variants_count+v_processed,
        phase=v_next_phase,
        cursor_a=case when v_next_phase='title_variants' then v_next_a end,
        cursor_b=case when v_next_phase='title_variants' then v_next_b end,
        cursor_c=null,
        cursor_id=case when v_next_phase='title_variants' then v_next_id end,
        processed_rows=progress.processed_rows+v_processed,
        updated_at=clock_timestamp()
      where progress.generation_id=v_progress.generation_id;
    elsif v_progress.phase = 'live_channels' then
      with page as materialized (
        select channel.id,channel.logical_id
        from public.cloud_live_logical_channels channel
        where channel.source_id=v_progress.source_id
          and channel.user_id=v_progress.user_id
          and channel.generation_id=v_progress.generation_id
          and (v_progress.cursor_a is null or
            (channel.logical_id,channel.id) >
            (v_progress.cursor_a,v_progress.cursor_id))
        order by channel.logical_id,channel.id limit v_limit
      )
      select count(*)::integer,
        (array_agg(logical_id order by logical_id desc,id desc))[1],
        (array_agg(id order by logical_id desc,id desc))[1]
      into v_processed,v_next_a,v_next_id from page;
      v_next_phase := case when v_processed<v_limit then 'live_variants'
        else 'live_channels' end;
      update public.cloud_source_catalog_manifest_seal_progress progress set
        live_channels_count=progress.live_channels_count+v_processed,
        phase=v_next_phase,
        cursor_a=case when v_next_phase='live_channels' then v_next_a end,
        cursor_b=null,cursor_c=null,
        cursor_id=case when v_next_phase='live_channels' then v_next_id end,
        processed_rows=progress.processed_rows+v_processed,
        updated_at=clock_timestamp()
      where progress.generation_id=v_progress.generation_id;
    elsif v_progress.phase = 'live_variants' then
      with page as materialized (
        select variant.id,variant.logical_id,variant.stream_id,
               coalesce(variant.label,'') label
        from public.cloud_live_variants variant
        where variant.source_id=v_progress.source_id
          and variant.user_id=v_progress.user_id
          and variant.generation_id=v_progress.generation_id
          and (v_progress.cursor_a is null or
            (variant.logical_id,variant.stream_id,coalesce(variant.label,''),variant.id) >
            (v_progress.cursor_a,v_progress.cursor_b,v_progress.cursor_c,
             v_progress.cursor_id))
        order by variant.logical_id,variant.stream_id,coalesce(variant.label,''),
          variant.id limit v_limit
      )
      select count(*)::integer,
        (array_agg(logical_id order by logical_id desc,stream_id desc,label desc,id desc))[1],
        (array_agg(stream_id order by logical_id desc,stream_id desc,label desc,id desc))[1],
        (array_agg(label order by logical_id desc,stream_id desc,label desc,id desc))[1],
        (array_agg(id order by logical_id desc,stream_id desc,label desc,id desc))[1]
      into v_processed,v_next_a,v_next_b,v_next_c,v_next_id from page;
      v_next_phase := case when v_processed<v_limit then 'episode_memberships'
        else 'live_variants' end;
      update public.cloud_source_catalog_manifest_seal_progress progress set
        live_variants_count=progress.live_variants_count+v_processed,
        phase=v_next_phase,
        cursor_a=case when v_next_phase='live_variants' then v_next_a end,
        cursor_b=case when v_next_phase='live_variants' then v_next_b end,
        cursor_c=case when v_next_phase='live_variants' then v_next_c end,
        cursor_id=case when v_next_phase='live_variants' then v_next_id end,
        processed_rows=progress.processed_rows+v_processed,
        updated_at=clock_timestamp()
      where progress.generation_id=v_progress.generation_id;
    elsif v_progress.phase = 'episode_memberships' then
      with page as materialized (
        select membership.parent_series_id,membership.episode_id
        from public.catalog_series_episode_memberships membership
        where membership.source_id=v_progress.source_id
          and membership.user_id=v_progress.user_id
          and membership.generation_id=v_progress.generation_id
          and (v_progress.cursor_a is null or
            (membership.parent_series_id,membership.episode_id) >
            (v_progress.cursor_a,v_progress.cursor_b))
        order by membership.parent_series_id,membership.episode_id limit v_limit
      )
      select count(*)::integer,
        (array_agg(parent_series_id order by parent_series_id desc,episode_id desc))[1],
        (array_agg(episode_id order by parent_series_id desc,episode_id desc))[1]
      into v_processed,v_next_a,v_next_b from page;
      v_next_phase := case when v_processed<v_limit then 'series_inventory'
        else 'episode_memberships' end;
      update public.cloud_source_catalog_manifest_seal_progress progress set
        episode_memberships_count=progress.episode_memberships_count+v_processed,
        phase=v_next_phase,
        cursor_a=case when v_next_phase='episode_memberships' then v_next_a end,
        cursor_b=case when v_next_phase='episode_memberships' then v_next_b end,
        cursor_c=null,cursor_id=null,
        processed_rows=progress.processed_rows+v_processed,
        updated_at=clock_timestamp()
      where progress.generation_id=v_progress.generation_id;
    elsif v_progress.phase = 'series_inventory' then
      with page as materialized (
        select inventory.parent_series_id
        from public.catalog_series_inventory_state inventory
        where inventory.source_id=v_progress.source_id
          and inventory.user_id=v_progress.user_id
          and inventory.generation_id=v_progress.generation_id
          and (v_progress.cursor_a is null or
            inventory.parent_series_id > v_progress.cursor_a)
        order by inventory.parent_series_id limit v_limit
      )
      select count(*)::integer,max(parent_series_id)
      into v_processed,v_next_a from page;
      v_next_phase := case when v_processed<v_limit then 'complete'
        else 'series_inventory' end;
      update public.cloud_source_catalog_manifest_seal_progress progress set
        series_inventory_count=progress.series_inventory_count+v_processed,
        phase=v_next_phase,
        cursor_a=case when v_next_phase='series_inventory' then v_next_a end,
        cursor_b=null,cursor_c=null,cursor_id=null,
        processed_rows=progress.processed_rows+v_processed,
        completed_at=case when v_next_phase='complete'
          then clock_timestamp() else null end,
        updated_at=clock_timestamp()
      where progress.generation_id=v_progress.generation_id;
    end if;
  end if;

  select count(*) = 2 into v_all_complete
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.seal_transition_id=p_transition_id
    and progress.phase='complete';

  if not v_all_complete then
    select generation.revision into v_candidate_revision
    from public.cloud_source_catalog_generations generation
    where generation.id=p_generation_id;
    select progress.* into v_progress
    from public.cloud_source_catalog_manifest_seal_progress progress
    where progress.seal_transition_id=p_transition_id
      and progress.phase<>'complete'
    order by case progress.seal_role when 'previous' then 0 else 1 end
    limit 1;
    return jsonb_build_object(
      'transitionId',p_transition_id,'generationId',p_generation_id,
      'generationState','BUILDING','generationRevision',v_candidate_revision,
      'sealRole',v_progress.seal_role,'sealPhase',v_progress.phase,
      'processedRows',v_processed,'batchLimit',v_limit,'complete',false,
      'leaseRetained',true,'checkpointRevision',v_job.checkpoint_revision
    );
  end if;

  select progress.* into v_candidate_progress
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.seal_transition_id=p_transition_id
    and progress.seal_role='candidate';
  select progress.* into v_previous_progress
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.seal_transition_id=p_transition_id
    and progress.seal_role='previous';
  if exists (
    select 1
    from public.cloud_source_catalog_generation_inventory_actions action
    where action.generation_id=p_generation_id
      and action.staged_item_count <> case action.action_kind
        when 'live' then v_candidate_progress.live_items_count
        when 'vod' then v_candidate_progress.movie_items_count
        when 'series' then v_candidate_progress.series_items_count end
  ) then
    raise exception 'candidate inventory ledger differs from sealed manifest'
      using errcode='55000',detail='reason=manifest_inventory_count_mismatch';
  end if;
  v_candidate_manifest :=
    public.norva_catalog_manifest_progress_result(p_generation_id);
  v_previous_manifest := public.norva_catalog_manifest_progress_result(
    v_transition.previous_catalog_generation_id
  );

  update public.cloud_source_catalog_generations generation
  set state='ready',manifest_sealing=false,
      manifest_counts=v_candidate_manifest->'counts',
      manifest_checksum=v_candidate_manifest->>'checksum',
      identity_evidence=v_candidate_manifest->'identityEvidence',
      gateway_complete_at=clock_timestamp(),ready_at=clock_timestamp(),
      revision=generation.revision+1,updated_at=clock_timestamp()
  where generation.id=p_generation_id
    and generation.state='building' and generation.manifest_sealing
    and generation.revision=v_candidate_progress.snapshot_revision
  returning generation.revision into v_candidate_revision;
  if not found then
    raise exception 'candidate manifest finalization CAS failed'
      using errcode='40001';
  end if;
  -- Keep A frozen only until the immediately following assessment records the
  -- exact comparison.  The assessment RPC releases it atomically; terminal
  -- failure/cancel also has a recovery trigger.
  update public.cloud_source_catalog_generations generation
  set manifest_counts=v_previous_manifest->'counts',
      manifest_checksum=v_previous_manifest->>'checksum',
      identity_evidence=v_previous_manifest->'identityEvidence',
      revision=generation.revision+1,updated_at=clock_timestamp()
  where generation.id=v_transition.previous_catalog_generation_id
    and generation.state='active' and generation.manifest_sealing
    and generation.revision=v_previous_progress.snapshot_revision;
  if not found then
    raise exception 'previous manifest finalization CAS failed'
      using errcode='40001';
  end if;
  delete from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.seal_transition_id = p_transition_id;
  get diagnostics v_fenced_generations = row_count;
  if v_fenced_generations <> 2 then
    raise exception 'catalog manifest progress cleanup CAS failed'
      using errcode='40001';
  end if;
  update public.cloud_source_credential_transition_jobs job
  set state='pending',lease_owner=null,lease_until=null,available_at=now(),
      checkpoint_revision=job.checkpoint_revision+1,last_error_code=null
  where job.id=p_job_id;
  return jsonb_build_object(
    'transitionId',p_transition_id,'generationId',p_generation_id,
    'generationState','READY','generationRevision',v_candidate_revision,
    'manifestCounts',v_candidate_manifest->'counts',
    'manifestChecksum',v_candidate_manifest->>'checksum',
    'sealRole',null,'sealPhase','complete','processedRows',v_processed,
    'batchLimit',v_limit,'complete',true,'leaseRetained',false
  );
end
$function$;

revoke all on function public.norva_catalog_manifest_progress_result(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.norva_compute_catalog_generation_manifest(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.norva_get_active_catalog_identity_evidence(uuid,uuid)
from public, anon, authenticated, service_role;
revoke all on function public.norva_preview_credential_catalog_manifest(uuid,uuid,uuid,uuid,text,integer)
from public, anon, authenticated, service_role;
revoke all on function public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)
from public, anon, authenticated, service_role;
grant execute on function public.norva_get_active_catalog_identity_evidence(uuid,uuid)
to service_role;
grant execute on function public.norva_preview_credential_catalog_manifest(uuid,uuid,uuid,uuid,text,integer)
to service_role;
grant execute on function public.norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)
to service_role;

notify pgrst, 'reload schema';
commit;
