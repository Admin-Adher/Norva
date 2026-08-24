begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- The legacy membership guard requires an enabled source for ordinary writes.
-- Generation expansion must also label the already-durable rows of disabled or
-- soft-deleted sources before NOT NULL contraction. Permit only the server
-- marker used by the bounded backfill, only NULL -> active-generation, and only
-- when generation_id is the sole caller-supplied change.
create or replace function public.guard_catalog_series_episode_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_online_generation_backfill boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_online_generation_backfill :=
      old.generation_id is null
      and new.generation_id is not null
      and current_setting(
        'norva.catalog_online_backfill_generation', true
      ) is not distinct from new.generation_id::text
      and (to_jsonb(new) - 'generation_id' - 'updated_at')
        is not distinct from (to_jsonb(old) - 'generation_id' - 'updated_at');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'catalog-series-episode-provider:' || new.provider_identity_id::text,
    0
  ));

  if v_online_generation_backfill then
    if not exists (
      select 1
      from public.cloud_title_variants variant
      where variant.id = new.parent_variant_id
        and variant.user_id = new.user_id
        and variant.source_id = new.source_id
        and variant.item_type = 'series'
        and variant.external_id = new.parent_series_id
        and variant.generation_id = new.generation_id
    ) then
      raise exception 'Episode membership online backfill parent generation mismatch'
        using errcode = '23503';
    end if;
  elsif not exists (
      select 1
      from public.cloud_title_variants variant
      join public.cloud_titles title
        on title.id = variant.title_id
       and title.user_id = variant.user_id
       and title.item_type = variant.item_type
      join public.cloud_sources source
        on source.id = variant.source_id
       and source.user_id = variant.user_id
       and source.deleted_at is null
       and source.enabled = true
      join public.catalog_source_provider_identities identity
        on identity.source_id = source.id
       and identity.user_id = source.user_id
      where variant.id = new.parent_variant_id
        and variant.user_id = new.user_id
        and variant.source_id = new.source_id
        and variant.title_id = new.parent_title_id
        and variant.item_type = 'series'
        and variant.external_id = new.parent_series_id
        and identity.identity_id = new.provider_identity_id
    ) then
      raise exception 'Episode membership does not match an active owned parent series variant'
        using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    if exists (
      select 1
      from public.catalog_series_episode_memberships existing
      where existing.provider_identity_id = new.provider_identity_id
        and existing.episode_id = new.episode_id
        and existing.parent_series_id is distinct from new.parent_series_id
    ) then
      raise exception 'Provider episode id is ambiguously attached to multiple parent series'
        using errcode = '23505';
    end if;
  else
    if exists (
      select 1
      from public.catalog_series_episode_memberships existing
      where existing.provider_identity_id = new.provider_identity_id
        and existing.episode_id = new.episode_id
        and existing.parent_series_id is distinct from new.parent_series_id
        and not (
          existing.source_id = old.source_id
          and existing.parent_series_id = old.parent_series_id
          and existing.episode_id = old.episode_id
        )
    ) then
      raise exception 'Provider episode id is ambiguously attached to multiple parent series'
        using errcode = '23505';
    end if;
  end if;

  new.parent_item_type := 'series';
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

revoke all on function public.guard_catalog_series_episode_membership()
  from public, anon, authenticated;

do $assert$
declare
  v_definition text;
begin
  select lower(pg_catalog.pg_get_functiondef(routine.oid))
    into strict v_definition
  from pg_catalog.pg_proc routine
  where routine.oid =
    'public.guard_catalog_series_episode_membership()'::regprocedure;

  if position('norva.catalog_online_backfill_generation' in v_definition) = 0
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.catalog_series_episode_memberships',
       'trg_guard_catalog_series_episode_membership',
       'public.guard_catalog_series_episode_membership()'::regprocedure,
       23
     ) then
    raise exception 'catalog series membership online-backfill guard drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
