begin;
set local lock_timeout='2s';
create table if not exists public.cloud_catalog_reader_windows (
 user_id uuid primary key references auth.users(id) on delete cascade,
 expires_at timestamptz not null
);
alter table public.cloud_catalog_reader_windows enable row level security;
revoke all on public.cloud_catalog_reader_windows from public,anon,authenticated,service_role;

-- Only a discarded authenticated read can request this through the Edge.
-- Taking the same epoch lock waits for the current payload transaction. The
-- subsequent writer checks below run AFTER acquiring that lock, so no new
-- credential payload can sneak between the retry window and its next read.
create or replace function public.norva_request_catalog_reader_window(p_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $f$
begin
 perform public.norva_credential_require_service_role();
 if not exists(select 1 from public.cloud_source_credential_transition_jobs j
   where j.user_id=p_user_id and j.job_kind='post_switch_verify' and j.state in ('pending','processing')) then return false; end if;
 perform 1 from public.cloud_user_catalog_visibility_epochs where user_id=p_user_id for update;
 if not found then return false; end if;
 insert into public.cloud_catalog_reader_windows(user_id,expires_at)
 values(p_user_id,clock_timestamp()+interval '10 seconds')
 on conflict(user_id) do update set expires_at=excluded.expires_at;
 return true;
end $f$;
revoke all on function public.norva_request_catalog_reader_window(uuid) from public,anon,authenticated,service_role;
grant execute on function public.norva_request_catalog_reader_window(uuid) to service_role;

create or replace function public.norva_assert_catalog_writer_window(p_user_id uuid)
returns void language plpgsql stable security definer set search_path='' as $f$
begin
 if exists(select 1 from public.cloud_catalog_reader_windows where user_id=p_user_id and expires_at>clock_timestamp()) then
  raise exception 'catalogue reader retry has priority' using errcode='PT409',detail='reason=catalog_reader_priority';
 end if;
end $f$;
revoke all on function public.norva_assert_catalog_writer_window(uuid) from public,anon,authenticated,service_role;

do $patch$
declare n text; body text; pattern text:=E'select epoch.visibility_epoch into v_epoch\\s+from public.cloud_user_catalog_visibility_epochs epoch\\s+where epoch.user_id = p_user_id\\s+for update;';
begin
 foreach n in array array['norva_begin_active_catalog_title_projection_refresh','norva_lock_active_catalog_refresh_lease','norva_upsert_active_catalog_title_payloads','norva_upsert_active_catalog_title_variants','norva_confirm_active_catalog_title_projection_batch','norva_complete_active_catalog_title_refresh_action','norva_reconcile_active_catalog_title_projection_batch','norva_mark_active_catalog_title_projection_refreshed'] loop
  select pg_get_functiondef(oid) into strict body from pg_proc where pronamespace='public'::regnamespace and proname=n;
  if (select count(*) from regexp_matches(body,pattern,'g'))<>1 then raise exception 'reader window lock contract drift: %',n; end if;
  execute regexp_replace(body,pattern,E'\\&\n  perform public.norva_assert_catalog_writer_window(p_user_id);');
 end loop;
end $patch$;
commit;
