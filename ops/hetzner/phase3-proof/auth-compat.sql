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

-- Present in current Supabase Auth and used by the migration history for
-- server-side claim checks.  It reads only the request-scoped GUC.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;
