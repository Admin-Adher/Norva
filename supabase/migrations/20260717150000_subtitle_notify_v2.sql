-- =============================================================================
-- Notifications sous-titres IA v2 — audit tunnel 2026-07-17 (gaps n°1/3/6/7)
-- =============================================================================
-- 1) Deep link : l'email « ready » pointait sur la RACINE du site — l'utilisateur
--    devait retrouver son film à la main. On stocke à l'opt-in de quoi construire
--    le lien de fiche : source_id (UUID cloud) + series_id (les épisodes sont
--    cachés par id d'ÉPISODE mais la fiche s'ouvre par id de SÉRIE).
-- 2) Reaper : il fauchait les jobs morts en base SANS résoudre les subscriptions
--    email — pending orphelin pour toujours, l'utilisateur n'apprenait jamais le
--    résultat. Le reaper résout désormais les pending en 'failed' ET sonne la
--    cloche in-app (cloud_content_events), comme le dispatch edge.
-- 3) Purge : la table n'avait aucun TTL (accumulation indéfinie). Les fenêtres
--    utiles se comptent en heures — 30 jours de rétention couvrent tout audit.

alter table public.catalog_generated_subtitle_notifications
  add column if not exists source_id text,
  add column if not exists series_id text;

comment on column public.catalog_generated_subtitle_notifications.source_id is
  'UUID de la source cloud du souscripteur au moment de l''opt-in — sert uniquement à construire '
  'le deep link de l''email/cloche (fiche films: external_id, fiche séries: series_id).';
comment on column public.catalog_generated_subtitle_notifications.series_id is
  'Id SÉRIE provider pour les souscriptions d''épisodes (external_id est l''id d''épisode, '
  'inutilisable pour ouvrir la fiche).';

-- Reaper + purge : cron.schedule est un upsert par jobname (le reaper existe déjà, on remplace sa
-- commande). Garde pg_proc : en environnement sans pg_cron (tests) tout ce bloc est ignoré.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'cron' and p.proname = 'schedule') then

    -- Reaper horaire : fauche les jobs morts ET résout leurs souscriptions (email jamais parti →
    -- 'failed' + événement cloche), au lieu de laisser des pending irrésolubles.
    perform cron.schedule('norva-generated-subtitle-reaper', '0 * * * *', $reap$
  with reaped as (
    update public.catalog_generated_subtitles
       set status = 'failed',
           error = coalesce(error, '') || ' [reaped: stuck in processing > 2h]',
           updated_at = now()
     where status = 'processing'
       and updated_at < now() - interval '2 hours'
     returning provider_key, item_type, external_id, kind, lang
  ), resolved as (
    update public.catalog_generated_subtitle_notifications n
       set status = 'failed', sent_at = now()
      from reaped r
     where n.status = 'pending'
       and n.provider_key = r.provider_key and n.item_type = r.item_type
       and n.external_id = r.external_id and n.kind = r.kind and n.lang = r.lang
     returning n.user_id, n.source_id, n.title_label, n.item_type, n.external_id, n.kind, n.lang
  )
  insert into public.cloud_content_events (user_id, source_id, kind, summary, payload)
  select user_id,
         case when source_id ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then source_id::uuid else null end,
         'subtitle_failed',
         left('AI subtitles for “' || coalesce(nullif(title_label, ''), 'your film') || '” failed — you can retry from the captions menu', 300),
         jsonb_build_object('itemType', item_type, 'externalId', external_id, 'kind', kind, 'lang', lang)
    from resolved;

  with reaped as (
    update public.catalog_generated_subtitles
       set status = 'failed',
           error = coalesce(error, '') || ' [reaped: pending-transcript orphaned > 24h]',
           updated_at = now()
     where status = 'pending-transcript'
       and updated_at < now() - interval '24 hours'
     returning provider_key, item_type, external_id, kind, lang
  ), resolved as (
    update public.catalog_generated_subtitle_notifications n
       set status = 'failed', sent_at = now()
      from reaped r
     where n.status = 'pending'
       and n.provider_key = r.provider_key and n.item_type = r.item_type
       and n.external_id = r.external_id and n.kind = r.kind and n.lang = r.lang
     returning n.user_id, n.source_id, n.title_label, n.item_type, n.external_id, n.kind, n.lang
  )
  insert into public.cloud_content_events (user_id, source_id, kind, summary, payload)
  select user_id,
         case when source_id ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then source_id::uuid else null end,
         'subtitle_failed',
         left('AI subtitles for “' || coalesce(nullif(title_label, ''), 'your film') || '” failed — you can retry from the captions menu', 300),
         jsonb_build_object('itemType', item_type, 'externalId', external_id, 'kind', kind, 'lang', lang)
    from resolved;
$reap$);

    -- Purge quotidienne (03:25, décalée des autres prunes) : tout > 30 j part — un pending de
    -- 30 jours est mort de toute façon (reaper + ready-check à l'opt-in le résolvent avant).
    perform cron.schedule('norva-gen-sub-notif-prune', '25 3 * * *',
      $j$delete from public.catalog_generated_subtitle_notifications where created_at < now() - interval '30 days'$j$);
  end if;
end $$;
