-- Phase 2 (dedup-plan.md) — sync-time dual-write wiring.
--
-- Mirror a source's catalogue into the provider-global catalog_* tables whenever
-- it finishes syncing (sync_status -> 'ready'), via a single trigger instead of
-- editing the multiple ready-transition points across the two finalize functions
-- (lower regression risk on the just-stabilised import/finalize path). Covers
-- every sync path — onboarding, manual re-sync, cron finalize — in one place.
--
-- GUC-gated, default OFF: until `app.norva_catalog_dual_write` is set to '1' the
-- trigger is a single cheap setting-check no-op, so the global cache stays empty
-- and there is zero storage overhead / behaviour change. We turn it on together
-- with per-user thinning + the read flip, when real multi-user overlap makes the
-- dedup pay off. Exception-guarded — a mirror failure can never break a sync.
--
-- Enable:  alter role authenticator set app.norva_catalog_dual_write = '1';
--          (or  alter database postgres set app.norva_catalog_dual_write = '1';)
-- Disable: alter role authenticator reset app.norva_catalog_dual_write;

create or replace function public.cloud_source_mirror_on_ready() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.norva_catalog_dual_write', true), '') = '1' then
    begin
      perform public.sync_source_to_catalog(new.id);
    exception when others then
      -- best-effort: never let the global mirror break a sync completion
      null;
    end;
  end if;
  return null; -- AFTER trigger: return value ignored
end; $$;
revoke all on function public.cloud_source_mirror_on_ready() from anon, authenticated;

drop trigger if exists trg_cloud_source_mirror_on_ready on public.cloud_sources;
create trigger trg_cloud_source_mirror_on_ready
  after update of sync_status on public.cloud_sources
  for each row
  when (new.sync_status = 'ready' and old.sync_status is distinct from new.sync_status)
  execute function public.cloud_source_mirror_on_ready();
