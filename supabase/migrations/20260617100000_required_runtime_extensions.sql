-- Bootstrap extensions referenced by later versioned migrations.
--
-- A blank Supabase database replays migrations while `db start` is starting,
-- before CI can execute a separate bootstrap script. Keep these declarations
-- idempotent so the same history works on local CI and on the self-hosted
-- runtime, where the extensions may already be installed.

create schema if not exists extensions;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $required_runtime_extensions$
begin
  if not exists (
    select 1
    from pg_extension
    where extname = 'pg_cron'
  ) then
    raise exception 'required extension pg_cron is unavailable';
  end if;

  if not exists (
    select 1
    from pg_extension
    where extname = 'pg_net'
  ) then
    raise exception 'required extension pg_net is unavailable';
  end if;
end
$required_runtime_extensions$;
