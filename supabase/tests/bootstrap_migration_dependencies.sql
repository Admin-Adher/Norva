-- Database-only CI starts the Supabase Postgres container without replaying
-- application migrations. Activate the two preloaded extensions that historical
-- migrations call while they are being replayed. Keep this test-only bootstrap
-- outside supabase/migrations: production owns extension lifecycle separately.

create schema if not exists extensions;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $bootstrap$
begin
  if not exists (
    select 1
    from pg_extension
    where extname = 'pg_cron'
  ) then
    raise exception 'CI bootstrap failed to activate pg_cron';
  end if;

  if not exists (
    select 1
    from pg_extension
    where extname = 'pg_net'
  ) then
    raise exception 'CI bootstrap failed to activate pg_net';
  end if;
end
$bootstrap$;
