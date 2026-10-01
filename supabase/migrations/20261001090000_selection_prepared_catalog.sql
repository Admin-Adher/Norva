begin;
create table public.selection_prepared_catalogs (
  revision text primary key check (revision ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (payload->>'version' = '1' and jsonb_typeof(payload->'rows') = 'array'),
  expires_at timestamptz not null
);
alter table public.selection_prepared_catalogs enable row level security;
revoke all on public.selection_prepared_catalogs from public, anon, authenticated;
grant select, insert, update, delete on public.selection_prepared_catalogs to service_role;
comment on table public.selection_prepared_catalogs is 'Service-only public Selection templates. Contains no owner bindings, history, entitlements or credentials. Expired entries are never used.';
commit;
