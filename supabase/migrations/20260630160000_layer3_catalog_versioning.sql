-- Layer 3 (orphan root-fix): make a catalogue sync NEVER empty the catalogue.
--
-- Today driveXtreamSyncToReady deletes ALL of a source's items upfront, then re-imports by
-- walking the provider category-by-category. fetchCatalog swallows provider errors (.catch(()=>[])),
-- so a rate-limited / expired account yields empty category slices, discovery "completes" with a
-- decimated (or empty) catalogue, and the source still flips to ready -> orphan titles + an empty
-- browse. The fix is upsert-then-prune: stamp every row seen in a run with that run's version, and
-- only AFTER a healthy+plausible discovery delete the rows NOT seen this run (the truly-removed
-- titles). A failed/partial run prunes nothing, so the prior catalogue stays intact.
--
-- This migration is purely additive (a nullable column + a batched prune RPC) and is safe to apply
-- while syncs are running: nothing reads catalog_version until the companion edge change ships, and
-- that edge change only takes the new path for runs that start AFTER it deploys (cursor.runVersion),
-- so in-flight legacy syncs are unaffected.

-- Per-run marker: the sync stamps this with its run version on every row it (re)sees. NULL = never
-- touched by a versioned run (legacy rows). Nullable + no default => instant add, no table rewrite.
alter table public.cloud_media_items
  add column if not exists catalog_version bigint;

-- Batched prune of the rows a completed, healthy run did NOT see (catalog_version distinct from the
-- run's version => provider no longer lists them). Mirrors delete_source_items_batch: subquery LIMIT
-- so no id list crosses the wire, FK cascades handled by the engine. The caller loops until it
-- returns < p_limit. Scoped to (source_id, user_id) and gated on a version match so it can only ever
-- remove rows from THIS source that the current run replaced.
create or replace function public.prune_stale_source_items(
  p_source uuid, p_user uuid, p_version bigint, p_limit integer default 2000
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n integer;
begin
  if p_version is null then
    return 0; -- never prune without an explicit run version (fail-safe)
  end if;
  delete from public.cloud_media_items
   where id in (
     select id from public.cloud_media_items
      where source_id = p_source
        and user_id = p_user
        and (catalog_version is distinct from p_version)
      limit greatest(1, least(coalesce(p_limit, 2000), 10000))
   );
  get diagnostics n = row_count;
  return n;
end;
$function$;

revoke all on function public.prune_stale_source_items(uuid, uuid, bigint, integer) from public;
grant execute on function public.prune_stale_source_items(uuid, uuid, bigint, integer) to service_role;
