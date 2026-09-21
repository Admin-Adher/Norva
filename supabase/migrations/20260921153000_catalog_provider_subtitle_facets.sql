begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Catalogue declarations are not selectable tracks or a proof of burned-in text.
-- Accept only an explicit subtitle role, never audio/country/original-language.
create function public.catalog_subtitle_language_code(p_value text)
returns text language sql immutable strict parallel safe security invoker set search_path='' as $f$
  with candidate as (
    select public.norva_canonical_language_code(coalesce(public.catalog_provider_language_alias(lower(btrim(p_value))),lower(btrim(p_value)))) as code
  )
  select case when lower(btrim(p_value))='yue' or public.catalog_provider_language_alias(lower(btrim(p_value)))='yue' then 'yue'
    when code=any(string_to_array('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu',' ')) then code end
  from candidate
$f$;
revoke all on function public.catalog_subtitle_language_code(text) from public,anon,authenticated;
grant execute on function public.catalog_subtitle_language_code(text) to service_role;

create function public.catalog_provider_subtitle_languages(p_metadata jsonb,p_raw_title text)
returns text[] language plpgsql immutable security invoker set search_path='' as $f$
declare envelope jsonb:=p_metadata->'providerLanguageDeclarations'; entry jsonb; label text;
  part text; token text; code text; codes text[]:='{}'; matched text[];
  raw text:=left(regexp_replace(coalesce(p_raw_title,''),'[▎▏▍▌│┃┆┊｜•·・]',' | ','g'),2000);
  category text:=left(coalesce(nullif(p_metadata->>'categoryName',''),p_metadata->>'category_name',''),1000);
  candidates text[]:='{}';
begin
  if envelope->>'schemaVersion'='1' and envelope->>'providerType'='xtream'
    and envelope->>'evidence'='provider_declaration' and jsonb_typeof(envelope->'declarations')='array'
    and octet_length(envelope::text)<=8192 then
    for entry in select value from jsonb_array_elements(envelope->'declarations') with ordinality e(value,n)
      where n<=32 and value->>'role'='subtitle' and jsonb_typeof(value->'values')='array'
    loop
      for label in select value from jsonb_array_elements_text(entry->'values') with ordinality e(value,n) where n<=8 loop
        if length(label)>80 or label ~ '[:<>@=]' then continue; end if;
        foreach token in array regexp_split_to_array(lower(btrim(label)),'\s*[,/|+&]\s*') loop
          code:=public.catalog_subtitle_language_code(token);
          if code ~ '^([a-z]{2}|yue)$' and code not in ('un','xx','zz') then codes:=array_append(codes,code); end if;
        end loop;
      end loop;
    end loop;
  end if;
  -- Only bounded supplier prefixes / release annotations and category labels.
  -- Ordinary title prose is never interpreted as a language declaration.
  candidates:=array_append(candidates,category);
  matched:=regexp_match(raw,'^\s*([A-Z0-9]+(?:[._/+-][A-Z0-9]+){0,4})(?:\s*[-–—]\s+|\s+[-–—]\s*|\s*[|:]\s*)');
  if matched is not null then candidates:=array_append(candidates,matched[1]); end if;
  for matched in select regexp_matches(raw,'[\[(]([^\]\[()]{1,80})[\])]','g') loop
    candidates:=array_append(candidates,matched[1]);
  end loop;
  -- VOSTxx is an explicit version tag, including a bare release suffix.
  for matched in select regexp_matches(raw,'\m(?:VOST|SUB)(FR|EN|ES|AR|DE|IT|PT|NL|RU)\M','gi') loop
    codes:=array_append(codes,lower(matched[1]));
  end loop;
  foreach part in array candidates loop
    part:=regexp_replace(part,'[\[\]() ]',' ','g');
    if part ~* '\m(?:NO|NONE|WITHOUT|SANS|AUCUNS?|SIN)\s+SUB(?:S|TITLES?)?\M' then continue; end if;
    for matched in select regexp_matches(part,'\m(?:VOST|SUB)(FR|EN|ES|AR|DE|IT|PT|NL|RU)\M','gi') loop
      codes:=array_append(codes,lower(matched[1]));
    end loop;
    -- Explicit named/code + SUB role, in either order. MULTI has no ISO value.
    for matched in select regexp_matches(part,'\m([[:alpha:]]{2,30})[ _./-]+(?:SUBS?|SUBT|SUBBED|SUBTITLES?)\M','gi') loop
      token:=lower(matched[1]);
      code:=public.catalog_subtitle_language_code(token);
      if code ~ '^([a-z]{2}|yue)$' and code not in ('un','xx','zz') then codes:=array_append(codes,code); end if;
    end loop;
    for matched in select regexp_matches(part,'\m(?:SUBS?|SUBT|SUBBED|SUBTITLES?)[ _./-]+(?:IN[ _./-]+)?([[:alpha:]]{2,30})\M','gi') loop
      token:=lower(matched[1]);
      code:=public.catalog_subtitle_language_code(token);
      if code ~ '^([a-z]{2}|yue)$' and code not in ('un','xx','zz') then codes:=array_append(codes,code); end if;
    end loop;
  end loop;
  return array(select distinct value from unnest(codes) value order by value);
end
$f$;
revoke all on function public.catalog_provider_subtitle_languages(jsonb,text) from public,anon,authenticated;
grant execute on function public.catalog_provider_subtitle_languages(jsonb,text) to service_role;

-- Sparse import-time projection, identical ownership/visibility model to audio.
-- Facet/page requests never parse an entire catalogue or hit a provider.
create table public.cloud_catalog_provider_subtitle_hints (
  variant_id uuid not null references public.cloud_title_variants(id) on delete cascade,
  user_id uuid not null,title_id uuid not null,source_id uuid not null,
  item_type text not null check(item_type in ('movie','series')),
  language text not null check(language ~ '^([a-z]{2}|yue)$'),
  primary key(variant_id,language)
);
alter table public.cloud_catalog_provider_subtitle_hints enable row level security;
revoke all on public.cloud_catalog_provider_subtitle_hints from public,anon,authenticated;
grant select,insert,update,delete on public.cloud_catalog_provider_subtitle_hints to service_role;
create index cloud_catalog_provider_subtitle_hints_scope_idx on public.cloud_catalog_provider_subtitle_hints(user_id,item_type,language,source_id,title_id,variant_id);
create index cloud_catalog_provider_subtitle_hints_source_idx on public.cloud_catalog_provider_subtitle_hints(user_id,source_id,item_type,language,title_id,variant_id);

create function public.cloud_catalog_refresh_provider_subtitle_hint()
returns trigger language plpgsql security invoker set search_path='' as $f$
declare codes text[];
begin
  if TG_OP='UPDATE' and (new.metadata,new.raw_title,new.user_id,new.title_id,new.source_id,new.item_type)
    is not distinct from (old.metadata,old.raw_title,old.user_id,old.title_id,old.source_id,old.item_type) then return new; end if;
  codes:=case when new.item_type in ('movie','series') then public.catalog_provider_subtitle_languages(new.metadata,new.raw_title) else '{}' end;
  delete from public.cloud_catalog_provider_subtitle_hints where variant_id=new.id and not(language=any(codes));
  insert into public.cloud_catalog_provider_subtitle_hints(variant_id,user_id,title_id,source_id,item_type,language)
    select new.id,new.user_id,new.title_id,new.source_id,new.item_type,language from unnest(codes) language
  on conflict(variant_id,language) do update set user_id=excluded.user_id,title_id=excluded.title_id,source_id=excluded.source_id,item_type=excluded.item_type
    where (cloud_catalog_provider_subtitle_hints.user_id,cloud_catalog_provider_subtitle_hints.title_id,cloud_catalog_provider_subtitle_hints.source_id,cloud_catalog_provider_subtitle_hints.item_type)
      is distinct from (excluded.user_id,excluded.title_id,excluded.source_id,excluded.item_type);
  return new;
end
$f$;
revoke all on function public.cloud_catalog_refresh_provider_subtitle_hint() from public,anon,authenticated;
grant execute on function public.cloud_catalog_refresh_provider_subtitle_hint() to service_role;
create trigger cloud_catalog_provider_subtitle_hint_insert after insert on public.cloud_title_variants for each row execute function public.cloud_catalog_refresh_provider_subtitle_hint();
create trigger cloud_catalog_provider_subtitle_hint_update after update of metadata,raw_title,user_id,title_id,source_id,item_type on public.cloud_title_variants for each row execute function public.cloud_catalog_refresh_provider_subtitle_hint();

-- Explicit, resumable per-owner rollout; no unbounded backfill during migration.
create function public.cloud_catalog_backfill_provider_subtitle_hints(p_user_id uuid,p_source_id uuid,p_after uuid default null,p_limit integer default 1000)
returns jsonb language plpgsql security invoker set search_path='' as $f$
declare row record; last_id uuid; scanned integer:=0; codes text[];
begin
  if p_user_id is null then raise exception 'Missing owner' using errcode='22023'; end if;
  for row in select variant.id,variant.user_id,variant.title_id,variant.source_id,variant.item_type,variant.metadata,variant.raw_title
    from public.cloud_title_variants variant where variant.user_id=p_user_id and variant.item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id) and (p_after is null or variant.id>p_after)
    order by variant.id limit greatest(1,least(coalesce(p_limit,1000),5000)) for share of variant
  loop
    last_id:=row.id; scanned:=scanned+1;
    codes:=public.catalog_provider_subtitle_languages(row.metadata,row.raw_title);
    delete from public.cloud_catalog_provider_subtitle_hints where variant_id=row.id and not(language=any(codes));
    insert into public.cloud_catalog_provider_subtitle_hints(variant_id,user_id,title_id,source_id,item_type,language)
      select row.id,row.user_id,row.title_id,row.source_id,row.item_type,language from unnest(codes) language
    on conflict(variant_id,language) do update set user_id=excluded.user_id,title_id=excluded.title_id,source_id=excluded.source_id,item_type=excluded.item_type;
  end loop;
  return jsonb_build_object('after',last_id,'scanned',scanned);
end
$f$;
revoke all on function public.cloud_catalog_backfill_provider_subtitle_hints(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.cloud_catalog_backfill_provider_subtitle_hints(uuid,uuid,uuid,integer) to service_role;

create function public.cloud_catalog_effective_subtitle_languages(p_user_id uuid,p_item_type text,p_source_id uuid,p_language text default null)
returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with visible_sources as materialized (
    -- Equivalent to the visible-variant view, checked once per source rather
    -- than reevaluating its security-barrier source policy for each file.
    select s.id,s.user_id,h.active_generation_id from public.cloud_catalog_visible_sources s
    left join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
    where s.user_id=p_user_id and (p_source_id is null or s.id=p_source_id)
  ), user_observations as materialized (
    select o.user_id,o.title_id,o.variant_id,o.file_external_id,o.subtitle_languages
    from public.cloud_title_file_language_observations o where o.user_id=p_user_id and o.subtitle_observed
  ), codes as materialized (
    -- Thousands of files reuse a tiny ISO vocabulary. Normalize each code once.
    select raw_code,public.catalog_subtitle_language_code(raw_code) as language
    from (select distinct unnest(subtitle_languages) raw_code from user_observations) raw
  ), observed as materialized (
    select o.title_id,o.variant_id,codes.language
    from user_observations o
    join public.cloud_title_variants v on v.user_id=o.user_id and v.title_id=o.title_id and v.id=o.variant_id
    join visible_sources source on source.id=v.source_id and source.user_id=v.user_id
      and (v.generation_id is null or source.active_generation_id=v.generation_id)
    join public.cloud_titles title on title.id=v.title_id and title.user_id=v.user_id and title.item_type=v.item_type
    cross join lateral unnest(o.subtitle_languages) code(value)
    join codes on codes.raw_code=code.value
    where o.user_id=p_user_id and v.item_type=p_item_type
      and p_item_type in ('movie','series') and (p_source_id is null or v.source_id=p_source_id)
      and (v.external_id=o.file_external_id or (v.item_type='series' and (
        exists(select 1 from public.catalog_series_episode_memberships m
          join public.catalog_source_provider_identities identity on identity.user_id=m.user_id and identity.source_id=m.source_id
            and identity.identity_id=m.provider_identity_id and identity.verified_at is not null
          where m.user_id=v.user_id and m.source_id=v.source_id and m.generation_id=v.generation_id
            and m.parent_variant_id=v.id and m.parent_title_id=v.title_id and m.parent_series_id=v.external_id
            and m.parent_item_type='series' and m.episode_id=o.file_external_id)
        or exists(select 1 from public.cloud_media_items episode
          where episode.user_id=v.user_id and episode.source_id=v.source_id and episode.generation_id=v.generation_id
            and episode.item_type='episode' and episode.available and episode.parent_external_id=v.external_id
            and episode.external_id=o.file_external_id)
      )))
  ), accepted as materialized (select * from observed where language ~ '^([a-z]{2}|yue)$' and language not in ('un','xx','zz'))
  select * from accepted where p_language is null or language=p_language
  union
  select hint.title_id,hint.variant_id,hint.language
  from public.cloud_catalog_provider_subtitle_hints hint
  join public.cloud_title_variants v on v.id=hint.variant_id and v.user_id=hint.user_id
    and v.title_id=hint.title_id and v.source_id=hint.source_id and v.item_type=hint.item_type
  join visible_sources source on source.id=v.source_id and source.user_id=v.user_id
    and (v.generation_id is null or source.active_generation_id=v.generation_id)
  join public.cloud_titles title on title.id=v.title_id and title.user_id=v.user_id and title.item_type=v.item_type
  where hint.user_id=p_user_id and hint.item_type=p_item_type and p_item_type in ('movie','series')
    and (p_source_id is null or hint.source_id=p_source_id) and (p_language is null or hint.language=p_language)
    -- Accepted languages override a conflicting label. Empty selectable tracks
    -- do not disprove separately declared subtitles; no soft-track claim is made.
    and not exists(select 1 from accepted a where a.variant_id=hint.variant_id and a.title_id=hint.title_id)
$f$;
revoke all on function public.cloud_catalog_effective_subtitle_languages(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_subtitle_languages(uuid,text,uuid,text) to service_role;

create function public.cloud_catalog_subtitle_language_counts(p_user_id uuid,p_item_type text,p_source_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $f$
  select coalesce(jsonb_object_agg(language,n),'{}'::jsonb) from (
    select language,count(distinct title_id) n from public.cloud_catalog_effective_subtitle_languages(p_user_id,p_item_type,p_source_id) group by language
  ) counts
$f$;
revoke all on function public.cloud_catalog_subtitle_language_counts(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_subtitle_language_counts(uuid,text,uuid) to service_role;

-- Preserve strict ISO preferences and filters. Only catalogue-prefixed subtitles
-- opt into declarations, with audio+subtitles co-occurring on the SAME variant.
create or replace function public.cloud_catalog_visible_title_ids_by_source_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_audio_language text default null,p_subtitle_language text default null
) returns table(title_id uuid) language sql stable security invoker set search_path='' as $f$
  with parameters as materialized (
    select nullif(lower(btrim(p_audio_language)),'') audio,nullif(lower(btrim(p_subtitle_language)),'') subtitle
  ), subtitle_variants as materialized (
    select s.* from parameters p cross join lateral public.cloud_catalog_effective_subtitle_languages(
      p_user_id,p_item_type,p_source_id,regexp_replace(p.subtitle,'^catalog-','')) s
    where p.subtitle ~ '^catalog-([a-z]{2}|yue)$'
  ), audio_variants as materialized (
    select e.title_id,e.variant_id from parameters p cross join lateral public.cloud_catalog_effective_audio_languages(
      p_user_id,p_item_type,p_source_id,regexp_replace(p.audio,'^(catalog|provider)-','')) e
    where p.subtitle ~ '^catalog-([a-z]{2}|yue)$' and p.audio ~ '^(catalog|provider)-'
    union
    select u.title_id,u.variant_id from parameters p cross join lateral public.cloud_catalog_unidentified_audio_variants(p_user_id,p_item_type,p_source_id) u
    where p.subtitle ~ '^catalog-([a-z]{2}|yue)$' and p.audio='unidentified'
    union
    select v.title_id,v.id from parameters p
    join public.cloud_title_file_language_observations o on o.user_id=p_user_id and o.audio_observed
    join public.cloud_catalog_visible_title_variants v on v.user_id=o.user_id and v.title_id=o.title_id and v.id=o.variant_id and v.external_id=o.file_external_id
    where p.subtitle ~ '^catalog-([a-z]{2}|yue)$' and p.audio ~ '^[a-z]{2,3}$' and p.audio=any(o.audio_languages)
      and v.item_type=p_item_type and (p_source_id is null or v.source_id=p_source_id)
  )
  select distinct s.title_id from subtitle_variants s,parameters p
  where p.audio is null or exists(select 1 from audio_variants a where a.variant_id=s.variant_id and a.title_id=s.title_id)
  union
  select legacy.title_id from parameters p cross join lateral public.cloud_catalog_provider_title_ids_by_source_languages(
    p_user_id,p_item_type,p_source_id,p.audio,p.subtitle) legacy
  where coalesce(p.audio,'') <> 'unidentified' and coalesce(p.subtitle,'') !~ '^catalog-'
  union
  select unknown_audio.title_id from parameters p
  cross join lateral public.cloud_catalog_unidentified_audio_variants(p_user_id,p_item_type,p_source_id) unknown_audio
  where p.audio='unidentified' and coalesce(p.subtitle,'') !~ '^catalog-'
    and (p.subtitle is null or exists(select 1 from public.cloud_title_file_language_observations observation
      join public.cloud_catalog_visible_title_variants variant on variant.user_id=observation.user_id and variant.title_id=observation.title_id
        and variant.id=observation.variant_id and variant.external_id=observation.file_external_id
      where observation.user_id=p_user_id and observation.title_id=unknown_audio.title_id and observation.variant_id=unknown_audio.variant_id
        and observation.subtitle_observed and p.subtitle=any(observation.subtitle_languages)))
$f$;
revoke all on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
