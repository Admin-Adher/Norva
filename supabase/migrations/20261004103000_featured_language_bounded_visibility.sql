begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Shared Selection titles are virtual owner-scoped ids. Visibility is checked
-- by the RPC; a foreign key to physical cloud_titles would reject those cards.
alter table public.catalog_featured_language_titles drop constraint catalog_featured_language_titles_title_id_fkey;

create or replace function public.record_catalog_featured_language_titles(p_user uuid,p_titles uuid[])
returns integer language plpgsql security definer set search_path='' set jit=off as $f$
declare written integer;
begin
 perform public.norva_credential_require_service_role();
 if p_user is null or cardinality(p_titles)>256 then raise exception 'Invalid featured title scope' using errcode='22023'; end if;
 if not exists(select 1 from auth.users where id=p_user and deleted_at is null and (banned_until is null or banned_until<=now())) then return 0; end if;
 delete from public.catalog_featured_language_titles where user_id=p_user and expires_at<=now();
 -- Bound physical ids before the visibility test. The full canonical title
 -- view computes per-title runtime for an entire large catalogue before LIMIT.
 with requested as materialized (
   select id,min(rank)::integer rank from unnest(p_titles) with ordinality x(id,rank) group by id
 ), sources as materialized (
   select s.id,h.active_generation_id from public.cloud_catalog_visible_sources s
   left join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
   where s.user_id=p_user
 ), physical as materialized (
   select t.id,r.rank from requested r join public.cloud_titles t on t.id=r.id
   where t.user_id=p_user and t.item_type in ('movie','series') and t.id=any(p_titles)
    and exists(select 1 from public.cloud_title_variants v join sources s on s.id=v.source_id
      where v.title_id=t.id and v.user_id=p_user and v.item_type=t.item_type
      and (v.generation_id is null or v.generation_id=s.active_generation_id))
 ), shared as materialized (
   select t.id,r.rank from requested r join public.selection_shared_visible_titles t on t.id=r.id
   where t.user_id=p_user and t.item_type in ('movie','series') and t.id=any(p_titles)
 ), visible as (select * from physical union select * from shared)
 insert into public.catalog_featured_language_titles(user_id,title_id,display_rank,seen_at,expires_at)
 select p_user,id,rank,now(),now()+interval '48 hours' from visible
 on conflict(user_id,title_id) do update set display_rank=excluded.display_rank,seen_at=excluded.seen_at,expires_at=excluded.expires_at
 where catalog_featured_language_titles.seen_at<now()-interval '6 hours';
 get diagnostics written=row_count;

 -- Selection's existing queue is public-file scoped. Match the published
 -- release AND exact URL fingerprint; change only priority, never retry,
 -- attempt counts, receipts, state or the active worker's admission checks.
 update public.catalog_selection_audio_jobs job set priority=1000
 from public.selection_shared_visible_variants v
 join public.selection_shared_visible_enrollments e on e.user_id=v.user_id and e.source_id=v.source_id
 join public.selection_shared_media m on m.release_id=e.release_id and m.item_type=v.item_type and m.external_id=v.external_id
 where v.user_id=p_user and v.title_id=any(p_titles) and v.item_type='movie'
  and m.available and m.playback_hint->>'targetUrl'=v.playback_hint->>'targetUrl'
  and job.external_id=v.external_id
  and job.url_sha256=encode(sha256(convert_to(m.playback_hint->>'targetUrl','UTF8')),'hex')
  and job.state in ('queued','retry_wait') and job.priority<1000;
 return written;
end $f$;
notify pgrst,'reload schema';
commit;
