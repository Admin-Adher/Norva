-- Keep the durable owner snapshot's declared present-row count aligned with
-- statement-level title mutations after a snapshot has left the builder.
--
-- Building snapshots deliberately remain owned by the paged builder: it
-- publishes an exact present-row count when the snapshot becomes ready. Once
-- ready/active/retained, transition-table triggers maintain the count without
-- introducing one parent-row update for every inserted catalogue row.

begin;

create or replace function public.norva_catalog_background_owner_rows_insert_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.cloud_catalog_background_owner_snapshots snapshot
  set row_count = snapshot.row_count + delta.present_delta,
      updated_at = now()
  from (
    select inserted.snapshot_id, count(*)::bigint as present_delta
    from inserted_owner_rows inserted
    where inserted.is_present
    group by inserted.snapshot_id
  ) delta
  where snapshot.id = delta.snapshot_id
    and snapshot.state in ('ready','active','retained')
    and delta.present_delta <> 0;
  return null;
end
$function$;

create or replace function public.norva_catalog_background_owner_rows_update_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.cloud_catalog_background_owner_snapshots snapshot
  set row_count = snapshot.row_count + delta.present_delta,
      updated_at = now()
  from (
    select changes.snapshot_id, sum(changes.present_delta)::bigint as present_delta
    from (
      select inserted.snapshot_id,
        count(*) filter (where inserted.is_present)::bigint as present_delta
      from updated_owner_rows inserted
      group by inserted.snapshot_id
      union all
      select removed.snapshot_id,
        -count(*) filter (where removed.is_present)::bigint as present_delta
      from replaced_owner_rows removed
      group by removed.snapshot_id
    ) changes
    group by changes.snapshot_id
  ) delta
  where snapshot.id = delta.snapshot_id
    and snapshot.state in ('ready','active','retained')
    and delta.present_delta <> 0;
  return null;
end
$function$;

create or replace function public.norva_catalog_background_owner_rows_delete_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.cloud_catalog_background_owner_snapshots snapshot
  set row_count = snapshot.row_count - delta.present_delta,
      updated_at = now()
  from (
    select removed.snapshot_id, count(*)::bigint as present_delta
    from deleted_owner_rows removed
    where removed.is_present
    group by removed.snapshot_id
  ) delta
  where snapshot.id = delta.snapshot_id
    and snapshot.state in ('ready','active','retained')
    and delta.present_delta <> 0;
  return null;
end
$function$;

revoke all on function public.norva_catalog_background_owner_rows_insert_count()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_catalog_background_owner_rows_update_count()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_catalog_background_owner_rows_delete_count()
  from public, anon, authenticated, service_role;

create or replace trigger trg_catalog_background_owner_rows_insert_count
after insert on public.cloud_catalog_background_owner_snapshot_rows
referencing new table as inserted_owner_rows
for each statement
execute function public.norva_catalog_background_owner_rows_insert_count();

create or replace trigger trg_catalog_background_owner_rows_update_count
after update on public.cloud_catalog_background_owner_snapshot_rows
referencing old table as replaced_owner_rows new table as updated_owner_rows
for each statement
execute function public.norva_catalog_background_owner_rows_update_count();

create or replace trigger trg_catalog_background_owner_rows_delete_count
after delete on public.cloud_catalog_background_owner_snapshot_rows
referencing old table as deleted_owner_rows
for each statement
execute function public.norva_catalog_background_owner_rows_delete_count();

-- Close any pre-trigger drift while the CREATE TRIGGER lock still prevents an
-- unobserved writer from crossing the migration boundary.
with exact_counts as (
  select snapshot.id,
    count(owner_row.title_id) filter (where owner_row.is_present)::bigint
      as present_count
  from public.cloud_catalog_background_owner_snapshots snapshot
  left join public.cloud_catalog_background_owner_snapshot_rows owner_row
    on owner_row.snapshot_id = snapshot.id
  where snapshot.state in ('ready','active','retained')
  group by snapshot.id
)
update public.cloud_catalog_background_owner_snapshots snapshot
set row_count = exact_counts.present_count,
    updated_at = case
      when snapshot.row_count is distinct from exact_counts.present_count
      then now() else snapshot.updated_at end
from exact_counts
where snapshot.id = exact_counts.id
  and snapshot.row_count is distinct from exact_counts.present_count;

do $assert$
begin
  if exists (
    select 1
    from public.cloud_catalog_background_owner_snapshots snapshot
    left join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = snapshot.id
    where snapshot.state in ('ready','active','retained')
    group by snapshot.id, snapshot.row_count
    having snapshot.row_count is distinct from
      count(owner_row.title_id) filter (where owner_row.is_present)::bigint
  ) then
    raise exception 'catalog background owner row_count repair is incomplete';
  end if;
end
$assert$;

commit;
