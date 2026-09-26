-- Disposable networkless PostgreSQL fixture. No production credentials or rows.
create role anon;
create role authenticated;
create role service_role;
create schema extensions;
create extension pgcrypto with schema extensions;
create table public.catalog_file_audio_validation_jobs (
 id uuid primary key, state text, lease_owner text, lease_expires_at timestamptz,
 quarantined_at timestamptz
);
create table public.provider_account_activity (
 account_key text primary key, kind text, last_seen_at timestamptz
);
create function public.provider_account_busy_for_foreground_validation(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
 select coalesce((select bool_or(last_seen_at>statement_timestamp()-interval '5 minutes'
   and kind is distinct from 'presence' and kind is distinct from 'language-validation')
 from public.provider_account_activity
 where account_key in (p_key,encode(extensions.digest(p_key,'sha256'),'hex'))),false)
$$;
create table public.yield_proof_baseline as
 select md5(pg_get_functiondef('public.provider_account_busy_for_foreground_validation(text)'::regprocedure)) hash;
create table public.yield_proof_checks(label text primary key);
create function public.yield_assert(ok boolean,label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'yield_fixture_%',label; end if;
 insert into public.yield_proof_checks values(label);
end $$;
insert into public.catalog_file_audio_validation_jobs values
 ('00000000-0000-0000-0000-000000000001','running','worker-a',now()+interval '5 minutes',null),
 ('00000000-0000-0000-0000-000000000002','running','worker-b',now()+interval '5 minutes',null);
insert into public.provider_account_activity values
 (encode(extensions.digest('fixture.invalid/account','sha256'),'hex'),'catalog-refresh',now());
