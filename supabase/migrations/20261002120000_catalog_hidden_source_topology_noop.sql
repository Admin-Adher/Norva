begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Cleaning a source already excluded from the catalogue cannot change the
-- visible source/generation map. Do not copy the owner's entire snapshot for
-- hidden -> purged lifecycle updates or disablement of that hidden source.
create or replace function public.norva_catalog_background_owner_topology_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if exists (
    select 1
    from public.cloud_source_transitions transition
    where transition.user_id = v_user_id
      and transition.transition_kind = 'credential'
      and transition.state = 'committing'
  ) then
    raise exception 'user catalog topology is fenced during credential cutover'
      using errcode = 'PT409';
  end if;

  -- Keep the cutover fence above for every operation, including maintenance.
  -- INSERT/DELETE and provider-access changes retain their existing behavior.
  if tg_op = 'UPDATE' and tg_table_schema = 'public'
     and not exists (
       select 1 from public.cloud_source_transitions transition
       where transition.user_id = v_user_id
         and transition.transition_kind = 'credential'
         and transition.state = 'ready_to_switch'
     ) then
    if tg_table_name = 'cloud_source_lifecycle' then
      if old.user_id is not distinct from new.user_id
         and old.source_id is not distinct from new.source_id
         and coalesce(old.lifecycle_state = 'active'
           and old.catalog_visibility = 'visible',false)
           is not distinct from coalesce(new.lifecycle_state = 'active'
             and new.catalog_visibility = 'visible',false) then
        return new;
      end if;
    elsif tg_table_name = 'cloud_sources' then
      if old.user_id is not distinct from new.user_id
         and old.id is not distinct from new.id then
        if coalesce(old.enabled and old.deleted_at is null,false)
             is not distinct from
               coalesce(new.enabled and new.deleted_at is null,false)
           or exists (
             select 1
             from public.cloud_source_lifecycle lifecycle
             where lifecycle.source_id = new.id
               and lifecycle.user_id = new.user_id
               and not coalesce(lifecycle.lifecycle_state = 'active'
                 and lifecycle.catalog_visibility = 'visible',false)
           ) then
          return new;
        end if;
      end if;
    end if;
  end if;

  perform public.norva_mark_catalog_background_owner_stale(v_user_id);
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

commit;
