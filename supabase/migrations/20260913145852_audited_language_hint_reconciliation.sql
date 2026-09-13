begin;
set local lock_timeout='2s';
set local statement_timeout='20s';

-- Reconcile only the derived projection, within an explicitly selected owner.
-- The original provider metadata and all observed/verified tracks are untouched.
-- Operators must paginate until scanned=0. Row locks prevent stale hints racing
-- catalogue imports; rerunning a completed batch is idempotent.
create function public.cloud_catalog_reconcile_provider_language_hints(
  p_user_id uuid,p_after uuid default null,p_limit integer default 1000
) returns jsonb language plpgsql security invoker set search_path='' as $f$
declare row record; last_id uuid; scanned integer:=0; changed integer:=0;
  removed integer:=0; affected integer; hint text;
begin
  if p_user_id is null or p_limit is null or p_limit<1 or p_limit>2000 then
    raise exception 'An explicit owner and a batch size between 1 and 2000 are required';
  end if;
  for row in select variant.id,variant.user_id,variant.title_id,variant.source_id,
      variant.item_type,variant.metadata,variant.external_id,variant.raw_title
    from public.cloud_title_variants variant
    where variant.user_id=p_user_id and variant.item_type in ('movie','series')
      and (p_after is null or variant.id>p_after)
    order by variant.id limit p_limit for share of variant
  loop
    last_id:=row.id; scanned:=scanned+1;
    hint:=public.catalog_provider_language(row.metadata,row.external_id,row.raw_title);
    if hint is null then
      delete from public.cloud_catalog_provider_language_hints
        where variant_id=row.id and user_id=p_user_id;
      get diagnostics affected = row_count;
      removed:=removed+affected;
    else
      insert into public.cloud_catalog_provider_language_hints as existing
        (variant_id,user_id,title_id,source_id,item_type,language)
        values(row.id,row.user_id,row.title_id,row.source_id,row.item_type,hint)
      on conflict(variant_id) do update set
        user_id=excluded.user_id,title_id=excluded.title_id,source_id=excluded.source_id,
        item_type=excluded.item_type,language=excluded.language
      where (existing.user_id,existing.title_id,existing.source_id,existing.item_type,existing.language)
        is distinct from (excluded.user_id,excluded.title_id,excluded.source_id,excluded.item_type,excluded.language);
      get diagnostics affected = row_count;
      changed:=changed+affected;
    end if;
  end loop;
  return jsonb_build_object('after',last_id,'scanned',scanned,'changed',changed,'removed',removed);
end
$f$;
revoke all on function public.cloud_catalog_reconcile_provider_language_hints(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.cloud_catalog_reconcile_provider_language_hints(uuid,uuid,integer) to service_role;

-- An observation containing only und/unknown cannot hide a declaration. Genuine
-- exact-file observations, including rare languages, still win over all hints.
create or replace function public.cloud_catalog_effective_audio_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_language text
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with codes as materialized (
    select raw_code,case raw_code when 'yue' then 'yue' else public.norva_canonical_language_code(raw_code) end as code
    from (select distinct unnest(audio_languages) as raw_code
      from public.cloud_title_file_language_observations where user_id=p_user_id and audio_observed) raw
  )
  select effective.* from (
    select variant.title_id,variant.id,codes.code
    from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id and variant.id=observation.variant_id
        and variant.external_id=observation.file_external_id
    cross join lateral unnest(observation.audio_languages) language(value)
    join codes on codes.raw_code=language.value
    where observation.user_id=p_user_id and observation.audio_observed
      and codes.code is not null and (p_language is null or codes.code=p_language)
      and variant.item_type=p_item_type and p_item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id)
    union all
    select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
    from public.cloud_catalog_provider_language_hints hint
    join public.cloud_catalog_visible_title_variants variant
      on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
    where hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
      and p_item_type in ('movie','series') and (p_source_id is null or hint.source_id=p_source_id)
      and (p_language is null or hint.language=p_language or (p_language='tl' and hint.language='fil'))
      and not exists(select 1 from public.cloud_title_file_language_observations observation
        cross join lateral unnest(observation.audio_languages) language(value)
        join codes on codes.raw_code=language.value and codes.code is not null
        where observation.user_id=hint.user_id and observation.title_id=hint.title_id and observation.variant_id=hint.variant_id
          and observation.file_external_id=variant.external_id and observation.audio_observed)
  ) effective(title_id,variant_id,language)
  join public.cloud_titles title on title.id=effective.title_id and title.user_id=p_user_id and title.item_type=p_item_type
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
