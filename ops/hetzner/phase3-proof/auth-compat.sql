-- The pinned proof image exposes the older GoTrue `confirmed_at` column while
-- the Norva migration history targets the current `email_confirmed_at` name.
-- This is schema-only compatibility for the empty synthetic proof database:
-- no production Auth schema or user data is imported.
alter table auth.users
  add column if not exists email_confirmed_at timestamptz;

update auth.users
set email_confirmed_at = confirmed_at
where email_confirmed_at is null
  and confirmed_at is not null;
