-- Security hardening (re-audit 2026-07-05): close SECURITY DEFINER grant drift.
--
-- Root cause: several SECURITY DEFINER catalog/sync functions were created with an explicit
-- `revoke ... from public; grant ... to service_role` in their original migration, but a later
-- `CREATE OR REPLACE FUNCTION` re-emitted the body WITHOUT re-revoking. CREATE OR REPLACE resets
-- a function's ACL to the PostgREST default (EXECUTE to PUBLIC → anon + authenticated), so the
-- live grant silently drifted back to anon-executable. Because these run SECURITY DEFINER (owned
-- by postgres), they bypass RLS — an unauthenticated caller holding only the shipped publishable
-- anon key could reach destructive/cross-tenant ops:
--   delete_source_items_batch / prune_stale_source_items / thin_source_media_items (data deletion),
--   fanout_file_tracks_to_users / upsert_catalog_file_tracks / upsert_catalog_file_ids
--   (cross-user catalog metadata poisoning), backfill_catalog_from_cloud (zero-arg heavy DoS),
--   sync_source_to_catalog, claim_generated_subtitle_job, norva_resolve_provider_identity,
--   provider_footprint_*, search_media_items, audio_tag_suspects, whisper_candidate_titles,
--   catalog_dedup_report, catalog_media_mirror_diff, cloud_source_mirror_on_ready.
--
-- Verified (repo grep): NONE of these is called from the browser client (public/js). Every caller
-- is an edge function (service_role) or pg_cron (postgres, superuser — bypasses grants) or a
-- trigger (runs in the owner's context). The ONLY anon-facing SECURITY DEFINER function is
-- app_public_flags() (pre-login maintenance banner) — deliberately kept on the allowlist below.
--
-- This loop is drift-proof by construction: it revokes anon/authenticated/public EXECUTE from
-- EVERY public SECURITY DEFINER function currently anon-executable except the allowlist, and
-- re-grants service_role. Placed late in the migration order so on a fresh rebuild it runs after
-- all function definitions and re-closes the hole. Idempotent (re-running matches nothing).
do $$
declare
  r record;
  allow text[] := array['app_public_flags'];  -- legitimately anon-facing (maintenance banner, pre-login)
begin
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not (p.proname = any(allow))
  loop
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', r.proname, r.args);
    execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
  end loop;
end $$;
