begin;
alter table public.catalog_storyboards
  add column renewal_owner_id uuid references auth.users(id) on delete set null,
  add column renewal_source_id uuid references public.cloud_sources(id) on delete set null,
  add column renewal_container text,
  add column renewal_duration double precision;
comment on column public.catalog_storyboards.renewal_source_id is
  'Owned source used to renew a durable Gateway storyboard; no transport credentials stored.';
-- Existing RLS remains service-role only. Legacy rows cannot be renewed.
commit;
