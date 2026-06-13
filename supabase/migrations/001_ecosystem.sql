-- Norva ecosystem tables

create table if not exists hubs (
  id uuid primary key default gen_random_uuid(),
  hub_name text not null default 'Norva Hub',
  local_url text,
  public_url text,
  created_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

create table if not exists pair_requests (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid references hubs(id) on delete cascade,
  code text unique not null,
  device_type text not null default 'tv',
  device_name text,
  status text not null default 'pending',
  device_token text,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index if not exists idx_pair_code on pair_requests(code);
create index if not exists idx_pair_status on pair_requests(status, expires_at);

create table if not exists paired_devices (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid references hubs(id) on delete cascade,
  device_type text not null,
  device_name text,
  local_user_id integer not null,
  revoked boolean default false,
  last_seen_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists cast_commands (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid references hubs(id) on delete cascade,
  target_device_id uuid references paired_devices(id) on delete cascade,
  command text not null,
  payload jsonb,
  acknowledged_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists watch_history_sync (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid references hubs(id) on delete cascade,
  local_user_id integer not null,
  item_id text not null,
  item_type text,
  item_name text,
  progress_seconds integer default 0,
  duration_seconds integer default 0,
  completed boolean default false,
  updated_at timestamptz default now(),
  unique(hub_id, local_user_id, item_id)
);

-- Public schema tables should always use RLS. The hub server uses the
-- service-role key, which bypasses RLS; public clients should not access these
-- tables directly unless explicit policies are added later.
alter table hubs enable row level security;
alter table pair_requests enable row level security;
alter table paired_devices enable row level security;
alter table cast_commands enable row level security;
alter table watch_history_sync enable row level security;

-- Enable Realtime on cast_commands and pair_requests
alter table pair_requests replica identity full;
alter table cast_commands replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pair_requests'
  ) then
    alter publication supabase_realtime add table pair_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cast_commands'
  ) then
    alter publication supabase_realtime add table cast_commands;
  end if;
end $$;
