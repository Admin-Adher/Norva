-- This service-only operation needs the same authority locks as other fenced
-- catalogue writers. The service role intentionally has no direct UPDATE
-- grant on lifecycle/epoch tables. Retain the explicit JWT service guard,
-- owner/generation checks, pinned search path and service-only execute ACL.
begin;
set local lock_timeout='3s';
alter function public.norva_cache_selection_title_recipes(text,jsonb)
  security definer;
alter function public.norva_apply_selection_title_recipes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid[],text)
  security definer;
commit;
