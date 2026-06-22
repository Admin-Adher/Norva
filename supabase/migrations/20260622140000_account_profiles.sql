-- Netflix-style multiple profiles per account.
--
-- The existing public.cloud_profiles stays the ACCOUNT-level row (display name,
-- locale, region defaults). This adds a separate table for the several profiles
-- an account can have — each with its own avatar and per-profile data (watch
-- history, favorites, continue-watching, content preferences).
--
-- ⚠️ This migration moves favorites/history uniqueness from account-scoped to
-- profile-scoped, so it MUST be deployed together with the matching norva-cloud
-- changes (which set profile_id and upsert on the new conflict target).

-- ---------------------------------------------------------------------------
-- 1. Profiles table (several per account)
-- ---------------------------------------------------------------------------
create table if not exists public.cloud_account_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  avatar_id text not null default 'avatar-01',
  is_kids boolean not null default false,            -- reserved: kids UI/restriction is a later phase
  preferred_audio_language text,
  preferred_subtitle_language text,
  preferred_genres jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_account_profiles_name_check check (char_length(btrim(name)) between 1 and 40)
);

create index if not exists idx_cloud_account_profiles_user
  on public.cloud_account_profiles(user_id, sort_order);

-- At most one default profile per account.
create unique index if not exists uidx_cloud_account_profiles_one_default
  on public.cloud_account_profiles(user_id) where is_default;

drop trigger if exists trg_cloud_account_profiles_updated_at on public.cloud_account_profiles;
create trigger trg_cloud_account_profiles_updated_at
before update on public.cloud_account_profiles
for each row execute function public.norva_set_updated_at();

alter table public.cloud_account_profiles enable row level security;

drop policy if exists "cloud_account_profiles_owner_all" on public.cloud_account_profiles;
create policy "cloud_account_profiles_owner_all"
on public.cloud_account_profiles for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

revoke all on table public.cloud_account_profiles from anon, authenticated, service_role;
grant select, insert, update, delete on table public.cloud_account_profiles to authenticated;
grant select, insert, update, delete on table public.cloud_account_profiles to service_role;

-- ---------------------------------------------------------------------------
-- 2. Per-profile dimension on the content tables
-- ---------------------------------------------------------------------------
alter table public.cloud_favorites
  add column if not exists profile_id uuid references public.cloud_account_profiles(id) on delete cascade;
alter table public.cloud_watch_history
  add column if not exists profile_id uuid references public.cloud_account_profiles(id) on delete cascade;
alter table public.cloud_playback_sessions
  add column if not exists profile_id uuid references public.cloud_account_profiles(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. Backfill: one default profile per existing account, then attach existing
--    favorites/history to it so nobody loses their data.
-- ---------------------------------------------------------------------------
insert into public.cloud_account_profiles (user_id, name, avatar_id, is_default, sort_order)
select u.user_id,
       coalesce(nullif(btrim(p.display_name), ''), 'Profile 1'),
       'avatar-01', true, 0
from (
  select id as user_id from public.cloud_profiles
  union
  select user_id from public.cloud_favorites
  union
  select user_id from public.cloud_watch_history
) u
left join public.cloud_profiles p on p.id = u.user_id
where not exists (
  select 1 from public.cloud_account_profiles ap where ap.user_id = u.user_id
);

update public.cloud_favorites f
set profile_id = ap.id
from public.cloud_account_profiles ap
where ap.user_id = f.user_id and ap.is_default and f.profile_id is null;

update public.cloud_watch_history h
set profile_id = ap.id
from public.cloud_account_profiles ap
where ap.user_id = h.user_id and ap.is_default and h.profile_id is null;

-- ---------------------------------------------------------------------------
-- 4. Move uniqueness from account-scoped to profile-scoped (two profiles can
--    each favorite / track the same item). Drop the old auto-named unique
--    constraints by introspection so the migration is name-agnostic.
-- ---------------------------------------------------------------------------
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.cloud_favorites'::regclass and contype = 'u'
     and pg_get_constraintdef(oid) ilike '%(user_id, source_id, item_type, item_id)%';
  if c is not null then execute format('alter table public.cloud_favorites drop constraint %I', c); end if;

  select conname into c from pg_constraint
   where conrelid = 'public.cloud_watch_history'::regclass and contype = 'u'
     and pg_get_constraintdef(oid) ilike '%(user_id, source_id, item_type, item_id)%';
  if c is not null then execute format('alter table public.cloud_watch_history drop constraint %I', c); end if;
end $$;

create unique index if not exists uidx_cloud_favorites_profile_item
  on public.cloud_favorites(profile_id, source_id, item_type, item_id);
create unique index if not exists uidx_cloud_watch_history_profile_item
  on public.cloud_watch_history(profile_id, source_id, item_type, item_id);

create index if not exists idx_cloud_favorites_profile
  on public.cloud_favorites(profile_id, created_at desc);
create index if not exists idx_cloud_watch_history_profile
  on public.cloud_watch_history(profile_id, updated_at desc);
