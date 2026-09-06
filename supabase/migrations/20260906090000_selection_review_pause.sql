begin;

-- Selection is withdrawn pending a complete provider quality review. Preserve
-- catalogue rows and normal visibility/lease guards; prevent stale clients or
-- background work from re-enabling the deterministic managed source.
create or replace function public.norva_guard_selection_review_pause()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_key text;
begin
  if new.enabled then
    v_key := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'norva-selection-v1:' || new.user_id::text, 'UTF8')), 'hex');
    if new.id::text = pg_catalog.substr(v_key,1,8)||'-'||pg_catalog.substr(v_key,9,4)
      ||'-4'||pg_catalog.substr(v_key,14,3)||'-a'||pg_catalog.substr(v_key,18,3)
      ||'-'||pg_catalog.substr(v_key,21,12) then
      raise exception 'Norva Selection is temporarily unavailable' using errcode = '55000';
    end if;
  end if;
  return new;
end
$function$;

revoke all on function public.norva_guard_selection_review_pause() from public, anon, authenticated, service_role;
create trigger trg_cloud_sources_selection_review_pause
before insert or update on public.cloud_sources
for each row execute function public.norva_guard_selection_review_pause();

commit;
