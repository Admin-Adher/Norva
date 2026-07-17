-- =============================================================================
-- Sous-titres IA sur tous les VOD — garde-fous serveur (audit workflow 2026-07-16)
-- =============================================================================
-- Le client ouvre désormais l'option IA aux ÉPISODES de série et aux titres qui
-- portent déjà des pistes texte (langues inutiles au viewer). Élargir la surface
-- cliquable sans borne serait irresponsable : chaque transcription/OCR est une
-- lecture provider COMPLÈTE + un slot whisper mono-file. Deux objets :
--
-- 1) generated_subtitle_requests — journal d'ÉVÉNEMENTS d'enqueue viewer.
--    Le cap ne peut PAS compter les rows du cache catalog_generated_subtitles :
--    claim/takeover/force réutilisent la même row sans toucher created_at, donc
--    une boucle de retries brûlerait des lectures provider illimitées avec un
--    compteur figé. On compte donc chaque enqueue ACCEPTÉ par la gateway
--    (1 row = 1 lecture provider réelle), caps : 10/24 h par user,
--    15/24 h par identité provider (norva-playback assertViewerTranscribeBudget).
--
-- 2) whitelist_subtitle_candidates devient MOVIE-ONLY. La whitelist prio-0
--    incluait les séries récemment jouées ; transcribeEnqueue({titleId}) résolvait
--    alors le PREMIER épisode et cachait le VTT sous l'id SÉRIE — une clé que le
--    player (qui porte l'id d'ÉPISODE) ne relit jamais. Budget nocturne (2 jobs/
--    nuit/provider !) gaspillé en rows fantômes. La couverture série passe par
--    l'on-demand per-épisode, cohérent avec le modèle on-demand-first.

create table if not exists public.generated_subtitle_requests (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  provider_key text not null default '',
  kind         text not null default 'transcript' check (kind in ('transcript', 'ocr')),
  created_at   timestamptz not null default now()
);
comment on table public.generated_subtitle_requests is
  'Journal des enqueues de transcription/OCR déclenchés par un viewer (1 row = 1 lecture provider '
  'acceptée par la gateway). Support du cap anti-abus 10/24h/user + 15/24h/identité — les rows du '
  'cache cross-user ne peuvent pas servir de compteur (claim/takeover les réutilisent sans trace).';

create index if not exists idx_gen_sub_req_user_created
  on public.generated_subtitle_requests (user_id, created_at desc);
create index if not exists idx_gen_sub_req_pkey_created
  on public.generated_subtitle_requests (provider_key, created_at desc);

alter table public.generated_subtitle_requests enable row level security;
-- Aucune policy : service_role uniquement (l'edge écrit/compte, personne d'autre ne lit).

-- Rétention : ce journal ne sert qu'à des fenêtres de 24 h — purge quotidienne des rows > 7 j,
-- accrochée au prune existant du cache series-info (même esprit housekeeping, cron dédié léger).
-- NOTE : cron.schedule est idempotent ; en environnement sans pg_cron (tests) ce bloc est ignoré.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('norva-gen-sub-requests-prune', '25 2 * * *',
      $j$delete from public.generated_subtitle_requests where created_at < now() - interval '7 days'$j$);
  end if;
end $$;

-- 2) Whitelist nocturne : films uniquement (les rows série-id sont inservables par le player).
create or replace function public.whitelist_subtitle_candidates(p_user uuid, p_limit integer default 20)
returns table(title_id uuid, priority integer)
language sql
stable
as $function$
  with played as (
    select distinct v.title_id
    from public.cloud_playback_events e
    join public.cloud_title_variants v
      on v.source_id = e.source_id and v.external_id = e.item_id and v.item_type = e.item_type
    where e.user_id = p_user
      and e.event_type in ('play_started', 'first_frame')
      and e.created_at > now() - interval '21 days'
      and v.title_id is not null
  )
  select t.id as title_id,
         (case when p.title_id is not null then 0 else 1 end) as priority
  from public.cloud_titles t
  left join played p on p.title_id = t.id
  where t.user_id = p_user
    -- Movie-only (2026-07-17) : une série candidate faisait transcrire le 1er épisode sous l'id
    -- SÉRIE (resolveVariantUrl, chemin fiche) — clé jamais relue par le player (id d'épisode).
    and t.item_type = 'movie'
    and t.default_variant_id is not null
    and not (coalesce(t.subtitle_tracks, '[]'::jsonb) @> '[{"extractable": true}]'::jsonb)
    and (
      p.title_id is not null
      or (
        t.release_year is not null
        and t.release_year >= (extract(year from now())::int - 1)
        and t.subtitle_probed_at is not null
      )
    )
  order by priority asc, t.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;

revoke all on function public.whitelist_subtitle_candidates(uuid, integer) from public;
grant execute on function public.whitelist_subtitle_candidates(uuid, integer) to service_role;
