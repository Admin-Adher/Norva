create table if not exists public.cloud_playback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.cloud_devices(id) on delete set null,
  playback_session_id uuid references public.cloud_playback_sessions(id) on delete set null,
  source_id uuid references public.cloud_sources(id) on delete set null,
  item_type text not null,
  item_id text not null,
  event_type text not null check (
    event_type in (
      'session_created',
      'play_requested',
      'play_started',
      'first_frame',
      'pause',
      'resume',
      'ended',
      'abandoned',
      'playback_error',
      'gateway_error'
    )
  ),
  position_seconds integer not null default 0 check (position_seconds >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  time_to_first_frame_ms integer check (time_to_first_frame_ms is null or time_to_first_frame_ms >= 0),
  playback_mode text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_cloud_playback_events_user_time
on public.cloud_playback_events(user_id, created_at desc);

create index if not exists idx_cloud_playback_events_session_time
on public.cloud_playback_events(playback_session_id, created_at desc);

create index if not exists idx_cloud_playback_events_item_time
on public.cloud_playback_events(user_id, item_type, item_id, created_at desc);

create index if not exists idx_cloud_playback_events_type_time
on public.cloud_playback_events(event_type, created_at desc);

alter table public.cloud_playback_events enable row level security;

drop policy if exists "cloud_playback_events_select_own" on public.cloud_playback_events;
create policy "cloud_playback_events_select_own"
on public.cloud_playback_events for select to authenticated
using (user_id = auth.uid());

drop policy if exists "cloud_playback_events_insert_own" on public.cloud_playback_events;
create policy "cloud_playback_events_insert_own"
on public.cloud_playback_events for insert to authenticated
with check (
  user_id = auth.uid()
  and (
    source_id is null
    or exists (
      select 1 from public.cloud_sources s
      where s.id = source_id and s.user_id = auth.uid()
    )
  )
  and (
    device_id is null
    or exists (
      select 1 from public.cloud_devices d
      where d.id = device_id and d.user_id = auth.uid() and d.revoked = false
    )
  )
  and (
    playback_session_id is null
    or exists (
      select 1 from public.cloud_playback_sessions p
      where p.id = playback_session_id and p.user_id = auth.uid()
    )
  )
);

revoke all on table public.cloud_playback_events from anon, authenticated, service_role;
grant select, insert on table public.cloud_playback_events to authenticated;
grant select, insert, update, delete on table public.cloud_playback_events to service_role;
