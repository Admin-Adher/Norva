begin;

-- The source reaper and the terminal cleanup worker share the same durable
-- cleanup job, but only the reaper used to publish the transaction-local
-- source authority before deleting rows. Once the reaper had set
-- provider_deletion_pending, the worker therefore collided with the account
-- deletion guard on its first remaining payload row and rolled back the whole
-- cron tick. Admit only the cleanup tables already hard-coded in the worker,
-- for the exact due job and hidden tombstone, while continuing to fence every
-- account-wide deletion preparation.
do $guard_patch$
declare
  v_signature regprocedure :=
    'public.norva_provider_account_delete_write_guard()'::regprocedure;
  v_definition text;
  v_marker constant text := 'source_delete_cleanup_guard_authority_v1';
  v_needle constant text :=
    E'    raise exception ''provider account deletion preparation fences catalog writes''\n';
  v_replacement text;
  v_occurrences integer;
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;

  if position(v_marker in v_definition) > 0 then
    return;
  end if;

  v_occurrences := (
    length(v_definition) - length(replace(v_definition,v_needle,''))
  ) / length(v_needle);
  if v_occurrences <> 1 then
    raise exception
      'source cleanup guard patch precondition drifted: expected 1 fence, found %',
      v_occurrences
      using errcode = '55000';
  end if;

  v_replacement :=
    E'    -- source_delete_cleanup_guard_authority_v1\n'
    || E'    -- DELETE-only, exact-source authority for the bounded cleanup worker.\n'
    || E'    if tg_op = ''DELETE''\n'
    || E'       and tg_table_name in (\n'
    || E'         ''cloud_playback_events'',\n'
    || E'         ''cloud_watch_history'',\n'
    || E'         ''cloud_title_rating_operations'',\n'
    || E'         ''cloud_title_ratings'',\n'
    || E'         ''cloud_content_events'',\n'
    || E'         ''catalog_enrichment_source_schedule'',\n'
    || E'         ''catalog_provider_inventory_backoff'',\n'
    || E'         ''catalog_generated_subtitle_notifications'',\n'
    || E'         ''catalog_subtitle_email_deliveries'',\n'
    || E'         ''cloud_import_notifications'',\n'
    || E'         ''catalog_source_provider_identities'',\n'
    || E'         ''cloud_catalog_background_owner_snapshot_sources'',\n'
    || E'         ''cloud_catalog_generation_backfill_sources'',\n'
    || E'         ''cloud_source_catalog_generation_candidate_titles'',\n'
    || E'         ''cloud_source_catalog_generation_categories'',\n'
    || E'         ''cloud_source_catalog_generation_category_lists'',\n'
    || E'         ''cloud_source_catalog_generation_inventory_actions'',\n'
    || E'         ''cloud_source_catalog_generation_title_promotions'',\n'
    || E'         ''cloud_source_catalog_manifest_seal_progress'',\n'
    || E'         ''cloud_source_catalog_title_refresh_actions'',\n'
    || E'         ''cloud_source_catalog_title_refresh_checkpoints''\n'
    || E'       )\n'
    || E'       and v_source_id is not null\n'
    || E'       and current_setting(''norva.catalog_purge_source'',true)\n'
    || E'         is not distinct from v_source_id::text\n'
    || E'       and exists (\n'
    || E'         select 1\n'
    || E'         from public.cloud_source_replacement_cleanup_jobs cleanup\n'
    || E'         join public.cloud_source_lifecycle lifecycle\n'
    || E'           on lifecycle.source_id = cleanup.source_id\n'
    || E'          and lifecycle.user_id = cleanup.user_id\n'
    || E'         join public.cloud_sources source\n'
    || E'           on source.id = cleanup.source_id\n'
    || E'          and source.user_id = cleanup.user_id\n'
    || E'         where cleanup.source_id = v_source_id\n'
    || E'           and cleanup.user_id = v_user_id\n'
    || E'           and cleanup.cleanup_kind in (''replacement'',''source_delete'')\n'
    || E'           and cleanup.state = ''pending''\n'
    || E'           and cleanup.available_at <= clock_timestamp()\n'
    || E'           and lifecycle.lifecycle_state = ''purge_pending''\n'
    || E'           and lifecycle.catalog_visibility = ''hidden''\n'
    || E'           and source.deleted_at is not null\n'
    || E'           and source.provider_deletion_pending\n'
    || E'           and not exists (\n'
    || E'             select 1\n'
    || E'             from public.cloud_provider_account_delete_preparations preparation\n'
    || E'             where preparation.user_id = cleanup.user_id\n'
    || E'               and preparation.state in (''pending'',''processing'',''ready'')\n'
    || E'           )\n'
    || E'       ) then\n'
    || E'      return old;\n'
    || E'    end if;\n'
    || v_needle;

  execute replace(v_definition,v_needle,v_replacement);
end
$guard_patch$;

-- Publish the exact source authority only after the worker has claimed and
-- locked the due job, source, lifecycle and account. Clear it before returning
-- so a caller that wraps several worker invocations in one transaction cannot
-- accidentally reuse stale cleanup authority. Do not claim cleanup work while
-- an account-wide deletion preparation owns the account.
do $worker_patch$
declare
  v_signature regprocedure :=
    'public.norva_run_replacement_cleanup_batch(text,integer)'::regprocedure;
  v_definition text;
  v_marker constant text := 'source_delete_cleanup_worker_authority_v1';
  v_start_old constant text :=
    E'  end if;\n'
    || E'  select job.* into v_job\n'
    || E'  from public.cloud_source_replacement_cleanup_jobs job\n';
  v_start_new constant text :=
    E'  end if;\n'
    || E'  perform set_config(''norva.catalog_purge_source'','''',true);\n'
    || E'  select job.* into v_job\n'
    || E'  from public.cloud_source_replacement_cleanup_jobs job\n';
  v_claim_old constant text :=
    E'  where job.state=''pending'' and job.available_at<=clock_timestamp()\n'
    || E'  order by job.available_at,job.transition_id\n'
    || E'  for update skip locked limit 1;\n';
  v_claim_new constant text :=
    E'  where job.state=''pending'' and job.available_at<=clock_timestamp()\n'
    || E'    and not exists (\n'
    || E'      select 1\n'
    || E'      from public.cloud_provider_account_delete_preparations preparation\n'
    || E'      where preparation.user_id = job.user_id\n'
    || E'        and preparation.state in (''pending'',''processing'',''ready'')\n'
    || E'    )\n'
    || E'  order by job.available_at,job.transition_id\n'
    || E'  for update skip locked limit 1;\n';
  v_delete_old constant text :=
    E'  v_remaining:=p_limit;\n'
    || E'  foreach v_table in array v_tables loop\n'
    || E'    exit when v_remaining<=0;\n'
    || E'    v_count:=public.norva_replacement_cleanup_delete_rows(\n';
  v_delete_new constant text :=
    E'  -- source_delete_cleanup_worker_authority_v1\n'
    || E'  perform set_config(''norva.catalog_purge_source'',v_job.source_id::text,true);\n'
    || v_delete_old;
  v_lock_old constant text :=
    E'  perform public.norva_credential_lock_account(v_job.user_id);\n'
    || E'  select source.* into v_source from public.cloud_sources source\n';
  v_lock_new constant text :=
    E'  perform public.norva_credential_lock_account(v_job.user_id);\n'
    || E'  -- Recheck after the account lock closes the claim/preparation race.\n'
    || E'  if exists (\n'
    || E'    select 1\n'
    || E'    from public.cloud_provider_account_delete_preparations preparation\n'
    || E'    where preparation.user_id = v_job.user_id\n'
    || E'      and preparation.state in (''pending'',''processing'',''ready'')\n'
    || E'  ) then\n'
    || E'    return jsonb_build_object(''claimed'',false,''complete'',true,\n'
    || E'      ''accountDeleteDeferred'',true,''deletedRows'',0);\n'
    || E'  end if;\n'
    || E'  select source.* into v_source from public.cloud_sources source\n';
  v_partial_old constant text :=
    E'    where transition_id=v_job.transition_id;\n'
    || E'    return jsonb_build_object(''claimed'',true,''complete'',false,\n'
    || E'      ''deletedRows'',v_deleted,''sourceId'',v_job.source_id);\n';
  v_partial_new constant text :=
    E'    where transition_id=v_job.transition_id;\n'
    || E'    perform set_config(''norva.catalog_purge_source'','''',true);\n'
    || E'    return jsonb_build_object(''claimed'',true,''complete'',false,\n'
    || E'      ''deletedRows'',v_deleted,''sourceId'',v_job.source_id);\n';
  v_complete_old constant text :=
    E'  return jsonb_build_object(''claimed'',true,''complete'',true,''deletedRows'',0,\n'
    || E'    ''sourceId'',v_job.source_id,''transitionId'',v_job.transition_id);\n';
  v_complete_new constant text :=
    E'  perform set_config(''norva.catalog_purge_source'','''',true);\n'
    || E'  return jsonb_build_object(''claimed'',true,''complete'',true,''deletedRows'',0,\n'
    || E'    ''sourceId'',v_job.source_id,''transitionId'',v_job.transition_id);\n';
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;

  if position(v_marker in v_definition) > 0 then
    return;
  end if;

  if position(v_start_old in v_definition) = 0
     or position(v_claim_old in v_definition) = 0
     or position(v_lock_old in v_definition) = 0
     or position(v_delete_old in v_definition) = 0
     or position(v_partial_old in v_definition) = 0
     or position(v_complete_old in v_definition) = 0 then
    raise exception 'source cleanup worker patch precondition drifted'
      using errcode = '55000';
  end if;

  v_definition := replace(v_definition,v_start_old,v_start_new);
  v_definition := replace(v_definition,v_claim_old,v_claim_new);
  v_definition := replace(v_definition,v_lock_old,v_lock_new);
  v_definition := replace(v_definition,v_delete_old,v_delete_new);
  v_definition := replace(v_definition,v_partial_old,v_partial_new);
  v_definition := replace(v_definition,v_complete_old,v_complete_new);
  execute v_definition;
end
$worker_patch$;

comment on function public.norva_provider_account_delete_write_guard() is
  'Fail-closed account deletion fence with exact due-job authority for bounded source payload cleanup.';
comment on function public.norva_run_replacement_cleanup_batch(text,integer) is
  'Claims one due source cleanup job, skips account deletion preparations and drains at most the requested row budget.';

commit;
