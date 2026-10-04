begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- A PostgREST .in() outside the scoped SQL function cannot be pushed through
-- its SET search_path boundary. Read the requested files through the existing
-- exact projection so a card never requires scanning the entire catalogue.
create function public.cloud_catalog_owned_movie_audio_declarations_batch(
  p_user_id uuid, p_source_id uuid, p_variant_ids uuid[]
) returns table(user_id uuid,source_id uuid,item_type text,title_id uuid,variant_id uuid,language text)
language plpgsql stable security invoker set search_path='' as $function$
begin
  if p_user_id is null or p_source_id is null or p_variant_ids is null then return; end if;
  if cardinality(p_variant_ids)>200 then
    raise exception 'Too many requested language variants' using errcode='22023';
  end if;
  return query
    select d.*
    from (select distinct id from unnest(p_variant_ids) requested(id) where id is not null) requested
    cross join lateral public.cloud_catalog_owned_audio_declarations_exact_movie(
      p_user_id,p_source_id,requested.id
    ) d;
end $function$;
revoke all on function public.cloud_catalog_owned_movie_audio_declarations_batch(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.cloud_catalog_owned_movie_audio_declarations_batch(uuid,uuid,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;
