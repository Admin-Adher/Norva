create table if not exists public.cloud_runtime_config (
  key text primary key,
  value text not null,
  is_secret boolean not null default true,
  description text,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.cloud_runtime_config enable row level security;

revoke all on table public.cloud_runtime_config from anon;
revoke all on table public.cloud_runtime_config from authenticated;
revoke all on table public.cloud_runtime_config from service_role;
grant select, insert, update, delete on table public.cloud_runtime_config to service_role;

drop policy if exists "cloud_runtime_config_no_public_access" on public.cloud_runtime_config;
create policy "cloud_runtime_config_no_public_access"
on public.cloud_runtime_config
as restrictive
for all
to anon, authenticated
using (false)
with check (false);
