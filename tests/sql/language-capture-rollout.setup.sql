-- Synthetic, networkless fixture; existing legacy/pilot selection is stubbed.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
create table public.cloud_sources(id uuid primary key,user_id uuid,enabled boolean,deleted_at timestamptz,sync_status text);
create table public.catalog_file_audio_validation_jobs(id uuid primary key,requested_by uuid,source_id uuid,state text,quarantined_at timestamptz);
create table public.fixture_global(enabled boolean);
insert into public.fixture_global values(false);
create table public.fixture_pilot(job_id uuid);
create table public.fixture_internal(user_id uuid);
create function public.catalog_language_capture_pipeline_enabled() returns boolean language sql stable as $$select enabled from public.fixture_global$$;
create function public.catalog_language_capture_pipeline_enabled_for_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select public.catalog_language_capture_pipeline_enabled() or exists (
   select 1 from public.fixture_pilot where job_id=p_job_id)
$$;
create function public.norva_credential_require_service_role() returns void language plpgsql as $$
begin
 if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
   raise exception 'service role required' using errcode='42501';
 end if;
end $$;
create table public.capture_rollout_checks(label text primary key);
create function public.rollout_assert(ok boolean,label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'rollout_fixture_%',label; end if;
 insert into public.capture_rollout_checks values(label);
end $$;
insert into auth.users(id) values
 ('00000000-0000-4000-8000-000000000010'), -- golden owner bucket 79
 ('00000000-0000-4000-8000-000000000001'); -- golden owner bucket 8899
insert into public.cloud_sources values
 ('10000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000010',true,null,'ready'),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true,null,'ready');
insert into public.catalog_file_audio_validation_jobs values
 ('20000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000010','queued',null),
 ('20000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000010','queued',null),
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','queued',null);
create table public.fixture_job_before as select * from public.catalog_file_audio_validation_jobs;
