begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Resolve the provider/source scope before entering the canonical visible view.
-- Split its disjoint active-generation/legacy branches to use the existing
-- natural index. Shared enrollment rows are fenced to the same active head by
-- selection_shared_visible_enrollments. The canonical view remains authoritative.
-- Only recipient selection changes; validation, writes, ACLs and ordering remain.
do $patch$
declare d text; old text; replacement text;
begin
 d:=pg_get_functiondef('public.record_catalog_file_audio_verification(text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb)'::regprocedure);
 old:=$old$
      select distinct
        variant.user_id,
        variant.title_id,
        variant.id as variant_id,
        variant.external_id
      from public.cloud_catalog_visible_title_variants variant
      join public.cloud_sources source
        on source.id = variant.source_id
       and source.user_id = variant.user_id
       and source.deleted_at is null
      left join public.catalog_source_provider_identities verified_identity
        on verified_identity.source_id = source.id
       and verified_identity.user_id = source.user_id
      where variant.item_type = 'movie'
        and variant.external_id = p_external_id
        and variant.title_id is not null
        and coalesce(
          verified_identity.identity_id::text,
          'source:' || source.id::text
        ) = p_server_host
      order by variant.user_id, variant.title_id, variant.id
$old$;
 replacement:=$new$
      with recipient_sources as materialized (
        select source.id,source.user_id,head.active_generation_id
        from public.cloud_sources source
        left join public.cloud_source_catalog_heads head
          on head.source_id=source.id and head.user_id=source.user_id
        left join public.catalog_source_provider_identities verified_identity
          on verified_identity.source_id=source.id and verified_identity.user_id=source.user_id
        where source.deleted_at is null
          and coalesce(verified_identity.identity_id::text,'source:'||source.id::text)=p_server_host
      )
      select distinct variant.user_id,variant.title_id,variant.id as variant_id,variant.external_id
      from recipient_sources source
      cross join lateral (
        select v.user_id,v.title_id,v.id,v.external_id
        from public.cloud_catalog_visible_title_variants v
        where v.user_id=source.user_id and v.source_id=source.id
          and v.item_type='movie' and v.external_id=p_external_id and v.title_id is not null
          and v.generation_id=source.active_generation_id
        union all
        select v.user_id,v.title_id,v.id,v.external_id
        from public.cloud_catalog_visible_title_variants v
        where v.user_id=source.user_id and v.source_id=source.id
          and v.item_type='movie' and v.external_id=p_external_id and v.title_id is not null
          and v.generation_id is null
        offset 0
      ) variant
      order by variant.user_id,variant.title_id,variant.id
$new$;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Audio verification recipient query drifted'; end if;
 execute replace(d,old,replacement);
end $patch$;
notify pgrst,'reload schema';
commit;
