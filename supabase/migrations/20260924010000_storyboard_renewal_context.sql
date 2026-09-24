begin;
alter table public.catalog_storyboards
  add column if not exists job_user_id uuid references auth.users(id) on delete set null,
  add column if not exists job_source_id uuid references public.cloud_sources(id) on delete set null,
  add column if not exists job_container text,
  add column if not exists job_duration double precision;
comment on column public.catalog_storyboards.job_source_id is
  'Owned source used to renew a durable Gateway storyboard; no transport credentials stored.';
-- Existing RLS remains service-role only. Legacy rows cannot be renewed.
commit;
