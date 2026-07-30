-- =============================================================================
-- Historique : doublons source_id NULL (audit sync 2026-07-17, P3)
-- =============================================================================
-- Le renouvellement d'une source orpheline ses lignes d'historique en
-- source_id=NULL (FK on delete set null). L'index unique
-- (profile_id, source_id, item_type, item_id) traite les NULL comme DISTINCTS :
-- l'ON CONFLICT de saveHistory ne matche jamais ces lignes → un même titre peut
-- accumuler plusieurs rows NULL. Le read fallback prend la plus récente donc
-- l'impact visible est faible, mais les données divergent silencieusement.
--
-- 1) dédoublonnage préalable (la plus récente de chaque groupe survit),
-- 2) l'index unique repasse en NULLS NOT DISTINCT (PG15+) — l'upsert matche
--    désormais aussi les lignes orphelines ; la cible ON CONFLICT de l'edge
--    (profile_id,source_id,item_type,item_id) infère cet index sans changement.

begin;

with ranked as (
  select id, row_number() over (
           partition by profile_id, item_type, item_id
           order by updated_at desc nulls last, created_at desc nulls last, id
         ) as rn
  from public.cloud_watch_history
  where source_id is null
)
delete from public.cloud_watch_history h
 using ranked r
 where h.id = r.id and r.rn > 1;

drop index if exists public.uidx_cloud_watch_history_profile_item;
create unique index uidx_cloud_watch_history_profile_item
  on public.cloud_watch_history (profile_id, source_id, item_type, item_id)
  nulls not distinct;

commit;
