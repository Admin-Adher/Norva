begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Ordered selectors expose one stable display payload per logical title.  The
-- display owner is ordered by active visible source/generation, deliberately
-- not by mutable playback cost or TTFF.  A first/last active membership change
-- can nevertheless change that owner, so it must invalidate every external
-- continuation cursor in the same transaction as the variant write.
create or replace function public.norva_cloud_title_variant_display_membership_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_prune_context jsonb;
begin
  -- The bounded inventory-prune RPC validates the exact transition/job/run
  -- lease in the row guard, suppresses these per-statement invalidations, and
  -- performs one explicit epoch bump after the whole slice.  Without this
  -- coalescing, the first DELETE would stale the proof used by the next table
  -- in the same slice and make large prunes impossible to resume.
  begin
    v_prune_context := nullif(current_setting(
      'norva.catalog_active_inventory_prune', true
    ), '')::jsonb;
  exception when others then
    v_prune_context := null;
  end;
  if jsonb_typeof(v_prune_context) = 'object'
     and (select count(*) from jsonb_object_keys(v_prune_context)) = 8
     and v_prune_context ?& array[
       'transitionId','userId','sourceId','generationId',
       'refreshRunId','jobId','worker','leaseSequence'
     ] then
    return null;
  end if;
  if tg_op = 'INSERT' then
    for v_user_id in
      with affected as materialized (
        select distinct row_state.user_id, row_state.source_id,
          row_state.generation_id
        from new_rows row_state
      )
      select distinct affected.user_id
      from affected
      left join public.cloud_source_catalog_heads head
        on head.source_id = affected.source_id
       and head.user_id = affected.user_id
      where affected.user_id is not null
        and affected.source_id is not null
        and (
          affected.generation_id is null
          or head.active_generation_id = affected.generation_id
        )
        and public.norva_source_catalog_visible_internal(
          affected.source_id, affected.user_id
        )
    loop
      perform public.norva_bump_user_catalog_visibility_epoch(v_user_id);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_user_id in
      with affected as materialized (
        select distinct row_state.user_id, row_state.source_id,
          row_state.generation_id
        from old_rows row_state
      )
      select distinct affected.user_id
      from affected
      left join public.cloud_source_catalog_heads head
        on head.source_id = affected.source_id
       and head.user_id = affected.user_id
      where affected.user_id is not null
        and affected.source_id is not null
        and (
          affected.generation_id is null
          or head.active_generation_id = affected.generation_id
        )
        and public.norva_source_catalog_visible_internal(
          affected.source_id, affected.user_id
        )
    loop
      perform public.norva_bump_user_catalog_visibility_epoch(v_user_id);
    end loop;
  else
    for v_user_id in
      with changed as materialized (
        select
          old_state.user_id as old_user_id,
          old_state.source_id as old_source_id,
          old_state.generation_id as old_generation_id,
          new_state.user_id as new_user_id,
          new_state.source_id as new_source_id,
          new_state.generation_id as new_generation_id
        from old_rows old_state
        full join new_rows new_state using (id)
        where row(
          old_state.user_id, old_state.source_id,
          old_state.generation_id, old_state.title_id
        ) is distinct from row(
          new_state.user_id, new_state.source_id,
          new_state.generation_id, new_state.title_id
        )
      ), affected as materialized (
        select old_user_id as user_id, old_source_id as source_id,
          old_generation_id as generation_id
        from changed
        union
        select new_user_id, new_source_id, new_generation_id
        from changed
      )
      select distinct affected.user_id
      from affected
      left join public.cloud_source_catalog_heads head
        on head.source_id = affected.source_id
       and head.user_id = affected.user_id
      where affected.user_id is not null
        and affected.source_id is not null
        and (
          affected.generation_id is null
          or head.active_generation_id = affected.generation_id
        )
        and public.norva_source_catalog_visible_internal(
          affected.source_id, affected.user_id
        )
    loop
      perform public.norva_bump_user_catalog_visibility_epoch(v_user_id);
    end loop;
  end if;
  return null;
end
$function$;

revoke all on function public.norva_cloud_title_variant_display_membership_changed()
from public, anon, authenticated, service_role;

drop trigger if exists trg_cloud_title_variants_display_epoch_i
on public.cloud_title_variants;
drop trigger if exists trg_cloud_title_variants_display_epoch_u
on public.cloud_title_variants;
drop trigger if exists trg_cloud_title_variants_display_epoch_d
on public.cloud_title_variants;

-- PostgreSQL runs same-kind triggers alphabetically.  Keep these names after
-- trg_cloud_title_variants_generation_revision_* so the shared lock order is
-- generation -> visibility epoch, matching swap and projection writers.
create or replace trigger trg_cloud_title_variants_zz_display_epoch_i
after insert on public.cloud_title_variants
referencing new table as new_rows
for each statement execute function
  public.norva_cloud_title_variant_display_membership_changed();

create or replace trigger trg_cloud_title_variants_zz_display_epoch_u
after update on public.cloud_title_variants
referencing old table as old_rows new table as new_rows
for each statement execute function
  public.norva_cloud_title_variant_display_membership_changed();

create or replace trigger trg_cloud_title_variants_zz_display_epoch_d
after delete on public.cloud_title_variants
referencing old table as old_rows
for each statement execute function
  public.norva_cloud_title_variant_display_membership_changed();

do $assert$
declare
  v_insert record;
  v_update record;
  v_delete record;
begin
  if not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_title_variants',
       'trg_cloud_title_variants_zz_display_epoch_i',
       'public.norva_cloud_title_variant_display_membership_changed()'::regprocedure,
       4
     )
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_title_variants',
       'trg_cloud_title_variants_zz_display_epoch_u',
       'public.norva_cloud_title_variant_display_membership_changed()'::regprocedure,
       16
     )
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_title_variants',
       'trg_cloud_title_variants_zz_display_epoch_d',
       'public.norva_cloud_title_variant_display_membership_changed()'::regprocedure,
       8
     ) then
    raise exception 'catalog title display membership epoch trigger drift'
      using errcode = '55000';
  end if;

  select trigger_state.tgnewtable, trigger_state.tgoldtable,
    cardinality(trigger_state.tgattr::smallint[]) as attribute_count
  into strict v_insert
  from pg_catalog.pg_trigger trigger_state
  where trigger_state.tgrelid = 'public.cloud_title_variants'::regclass
    and trigger_state.tgname = 'trg_cloud_title_variants_zz_display_epoch_i';
  select trigger_state.tgnewtable, trigger_state.tgoldtable,
    cardinality(trigger_state.tgattr::smallint[]) as attribute_count
  into strict v_update
  from pg_catalog.pg_trigger trigger_state
  where trigger_state.tgrelid = 'public.cloud_title_variants'::regclass
    and trigger_state.tgname = 'trg_cloud_title_variants_zz_display_epoch_u';
  select trigger_state.tgnewtable, trigger_state.tgoldtable,
    cardinality(trigger_state.tgattr::smallint[]) as attribute_count
  into strict v_delete
  from pg_catalog.pg_trigger trigger_state
  where trigger_state.tgrelid = 'public.cloud_title_variants'::regclass
    and trigger_state.tgname = 'trg_cloud_title_variants_zz_display_epoch_d';

  if v_insert.tgnewtable is distinct from 'new_rows'
     or v_insert.tgoldtable is not null
     or v_insert.attribute_count <> 0
     or v_update.tgnewtable is distinct from 'new_rows'
     or v_update.tgoldtable is distinct from 'old_rows'
     or v_update.attribute_count <> 0
     or v_delete.tgnewtable is not null
     or v_delete.tgoldtable is distinct from 'old_rows'
     or v_delete.attribute_count <> 0 then
    raise exception 'catalog title display membership transition table drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
