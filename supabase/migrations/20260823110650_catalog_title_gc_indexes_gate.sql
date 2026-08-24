begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Exact metadata gate shared by terminal purge, feature activation, and the
-- catalog-generation contract.  These four indexes keep candidate-title shell
-- cleanup bounded; a valid homonym with the wrong table/keys/options must not
-- silently turn one purge batch into repeated full business-table scans.
create or replace function public.norva_title_gc_indexes_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    public.norva_title_gc_index_is_exact(
      'catalog_series_episode_memberships_parent_title_gc_idx',
      'public.catalog_series_episode_memberships',
      array['parent_title_id'], true
    )
    and public.norva_title_gc_index_is_exact(
      'catalog_series_inventory_state_parent_title_gc_idx',
      'public.catalog_series_inventory_state',
      array['parent_title_id'], true
    )
    and public.norva_title_gc_index_is_exact(
      'cloud_title_rating_operations_title_owner_gc_idx',
      'public.cloud_title_rating_operations',
      array['title_id','user_id'], true
    )
    and public.norva_title_gc_index_is_exact(
      'cloud_title_ratings_title_owner_gc_idx',
      'public.cloud_title_ratings',
      array['title_id','user_id'], true
    )
$function$;

revoke all on function public.norva_title_gc_indexes_ready()
from public, anon, authenticated, service_role;

do $postcondition$
begin
  if not public.norva_title_gc_indexes_ready() then
    raise exception 'candidate title GC index inventory is incomplete or drifted'
      using errcode = '55000';
  end if;
end
$postcondition$;

commit;
