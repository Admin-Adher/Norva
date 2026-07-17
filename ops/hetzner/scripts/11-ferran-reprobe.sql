-- =============================================================================
-- 11-ferran-reprobe.sql — re-probe ciblé du panel IPTV Ferran (échantillon 10 :
-- 5/12 récupérables par HEADER-PROBE, 0 par vod → le mode vod est AVEUGLE sur
-- ce panel ; ~8k des 20 152 « sondés sans langue » sont récupérables)
-- =============================================================================
-- Fait trois choses :
--   [0] imprime la TOPOLOGIE (compte propriétaire de Ferran, ses autres sources,
--       les crons qui portent ce userId) — pour décider ensuite s'il faut scoper
--       un cron account-wide en mode vod (à me recoller).
--   [1] RESET du bucket Ferran : audio_probed_at=null sur les titres sondés,
--       0 langue, 0 piste → ils redeviennent candidats du crawl.
--   [2] crée le cron per-source `norva-audio-ferran-probe` en mode PROBE
--       (fenêtre jour 6-23, limit 25, conc 1, fallthrough) — même traitement
--       que les panels AÎRO ; host distinct = slot distinct, pas de collision.
--
--   ⚠ LANCER EN supabase_admin (cron.schedule + propriété des jobs) :
--   docker exec -i norva-db psql -U supabase_admin -d postgres -P pager=off \
--     < ops/hetzner/scripts/11-ferran-reprobe.sql
--
-- ROLLBACK : select cron.unschedule('norva-audio-ferran-probe');
--   (le reset n'a pas de rollback — il re-sonde, il ne détruit rien : un titre
--    réellement mort sera re-marqué « sondé sans langue » au passage suivant.)
-- =============================================================================
\pset pager off
set statement_timeout = '300s';

\echo ''
\echo '================ [0] TOPOLOGIE — compte de Ferran + ses sources ================'
select s.id as source_id, coalesce(s.display_name, left(s.id::text, 8)) as panel,
       u.email::text as owner_email, s.user_id,
       (select count(*) from cloud_title_variants v where v.source_id = s.id) as variants
from cloud_sources s
left join auth.users u on u.id = s.user_id
where s.user_id = (select user_id from cloud_sources where id = 'b56d79e9-e947-4164-83b4-8d2ef087333d')
order by variants desc;

\echo ''
\echo '================ [0bis] Crons qui portent ce userId (mode vod à scoper ?) ================'
select jobid, jobname, schedule, active,
       (command like '%''vod''%') as mode_vod,
       (command like '%sourceId%') as deja_scope_source
from cron.job
where command like '%' || (select user_id::text from cloud_sources where id = 'b56d79e9-e947-4164-83b4-8d2ef087333d') || '%'
order by jobname;

\echo ''
\echo '================ [1] RESET du bucket Ferran (sondé · 0 langue · 0 piste) ================'
select count(*) as bucket_avant
from cloud_titles ct
join cloud_title_variants v on v.id = ct.default_variant_id
where v.source_id = 'b56d79e9-e947-4164-83b4-8d2ef087333d'
  and ct.variant_count > 0
  and ct.audio_languages = '{}' and ct.audio_probed_at is not null
  and (ct.audio_tracks is null or jsonb_typeof(ct.audio_tracks) <> 'array' or jsonb_array_length(ct.audio_tracks) = 0);

update cloud_titles ct
   set audio_probed_at = null
  from cloud_title_variants v
 where v.id = ct.default_variant_id
   and v.source_id = 'b56d79e9-e947-4164-83b4-8d2ef087333d'
   and ct.variant_count > 0
   and ct.audio_languages = '{}' and ct.audio_probed_at is not null
   and (ct.audio_tracks is null or jsonb_typeof(ct.audio_tracks) <> 'array' or jsonb_array_length(ct.audio_tracks) = 0);

select count(*) as jamais_sonde_apres
from cloud_titles ct
join cloud_title_variants v on v.id = ct.default_variant_id
where v.source_id = 'b56d79e9-e947-4164-83b4-8d2ef087333d'
  and ct.variant_count > 0
  and ct.audio_languages = '{}' and ct.audio_probed_at is null;

\echo ''
\echo '================ [2] Cron per-source Ferran en mode PROBE (jour 6-23) ================'
do $do$
declare v_user uuid; v_cmd text;
begin
  select user_id into v_user from cloud_sources where id = 'b56d79e9-e947-4164-83b4-8d2ef087333d';
  if v_user is null then
    raise notice 'source Ferran introuvable — cron non créé';
    return;
  end if;
  v_cmd := format($c$
  select net.http_post(
    url := 'https://api.norva.tv/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','%s','sourceId','b56d79e9-e947-4164-83b4-8d2ef087333d','type','movie','mode','probe','limit',25,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000
  );
$c$, v_user);
  perform cron.schedule('norva-audio-ferran-probe', '2-59/4 6-23 * * *', v_cmd);
  raise notice 'cron norva-audio-ferran-probe cree (probe, 2-59/4 6-23, userId=%)', v_user;
end $do$;

\echo ''
\echo '================ APRÈS — vérification ================'
select jobid, jobname, schedule, active from cron.job where jobname = 'norva-audio-ferran-probe';
\echo ''
\echo 'Colle-moi la sortie COMPLÈTE : selon [0bis] je te donne le dernier geste (scoper le'
\echo 'cron vod account-wide pour qu''il ne re-marque pas Ferran en aveugle, ou le passer en probe).'
