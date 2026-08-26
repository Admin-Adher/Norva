create or replace function public.norva_catalog_account_delete_write_guard_cached()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_source_id uuid := case when tg_op = 'DELETE' then old.source_id else new.source_id end;
  v_nonce text := nullif(current_setting('norva.catalog_guard_nonce', true), '');
  v_cache_name text;
  v_cache jsonb;
  v_preparing boolean := false;
begin
  if v_user_id is null or public.norva_provider_account_delete_fenced(v_user_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- The catalog statement trigger rotates this nonce before every statement.
  -- A successful first-row check may therefore be reused only by later rows in
  -- this exact SQL statement. The KEY SHARE lock acquired below remains held to
  -- transaction end, so neither auth deletion nor deletion preparation can race
  -- between the cached proof and a later row.
  if v_nonce is not null then
    v_cache_name := 'norva.catalog_account_guard_' || pg_catalog.md5(v_user_id::text);
    begin
      v_cache := nullif(current_setting(v_cache_name, true), '')::jsonb;
    exception when others then
      v_cache := null;
    end;
    if v_cache ->> 'nonce' is not distinct from v_nonce
       and coalesce((v_cache ->> 'allowed')::boolean, false) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
  end if;

  begin
    perform 1
    from auth.users account
    where account.id = v_user_id
    for key share nowait;
    if not found then
      raise exception 'provider account is unavailable' using errcode = 'P0002';
    end if;
  exception when lock_not_available then
    raise exception 'provider account deletion fence is busy'
      using errcode = '40001', detail = 'reason=provider_account_fence_busy';
  end;

  select exists (
    select 1
    from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id = v_user_id
      and preparation.state in ('pending','processing','ready')
  ) or exists (
    select 1
    from public.cloud_sources source
    where source.id = v_source_id
      and source.user_id = v_user_id
      and source.provider_deletion_pending
  ) into v_preparing;

  if v_preparing then
    raise exception 'provider account deletion preparation fences catalog writes'
      using errcode = '40001', detail = 'reason=provider_account_delete_preparing';
  end if;

  if v_cache_name is not null then
    perform set_config(
      v_cache_name,
      jsonb_build_object('nonce', v_nonce, 'allowed', true)::text,
      true
    );
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

revoke all on function public.norva_catalog_account_delete_write_guard_cached()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_aaa_provider_account_delete_write_guard
  on public.cloud_live_logical_channels;
create trigger trg_aaa_provider_account_delete_write_guard
before insert or update or delete on public.cloud_live_logical_channels
for each row execute function public.norva_catalog_account_delete_write_guard_cached();

drop trigger if exists trg_aaa_provider_account_delete_write_guard
  on public.cloud_live_variants;
create trigger trg_aaa_provider_account_delete_write_guard
before insert or update or delete on public.cloud_live_variants
for each row execute function public.norva_catalog_account_delete_write_guard_cached();
