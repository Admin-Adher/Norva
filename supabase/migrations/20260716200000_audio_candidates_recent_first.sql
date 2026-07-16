-- Enrichissement audio — prioriser la couverture UTILE : sonder les titres récents d'abord.
--
-- Constat (diag 2026-07-16, 08-enrichment-audio-diag.sql) : 167 980 titres jamais sondés,
-- drainés dans un ordre arbitraire (la RPC n'avait AUCUN order by → ordre de heap). Or les
-- titres récents (2-3 dernières années) concentrent l'essentiel des lectures réelles : à débit
-- égal, les sonder d'abord fait monter la couverture *perçue par les utilisateurs* bien plus
-- vite que la couverture brute. Les titres sans année (non matchés TMDB) passent en dernier —
-- cohérent : obscurs/non identifiés = faible probabilité de lecture. Le complément lazy
-- (enrichissement à la lecture réelle) couvre déjà gratuitement tout titre effectivement joué.
--
-- Sans risque de curseur : ni la RPC ni les crons ne paginent (afterId n'est jamais envoyé par
-- les crons ; la progression repose sur le marquage audio_probed_at/subtitle_probed_at). Le
-- chemin account-wide inline (norva-playback runOneDimension) reçoit le MÊME ordre dans l'edge,
-- sauf quand un appel manuel passe afterId (la pagination gt(id) suppose l'ordre id — conservé
-- dans ce cas). Coût : top-N heapsort sur le pool candidat du panel à chaque tick (~1-2 s pour
-- les plus gros pools) — négligeable devant les ~100 s de sondes du tick.
create or replace function public.audio_backfill_candidates(
  p_user uuid,
  p_source uuid,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
  p_limit int default 25
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text)
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_lim int := greatest(1, least(300, coalesce(p_limit, 25)));
  v_sql text;
begin
  v_sql := format(
    'select ct.id, ct.default_variant_id, ct.provider_tmdb_id '
    'from public.cloud_title_variants v '
    'join public.cloud_titles ct on ct.id = v.title_id and ct.default_variant_id = v.id '
    'where v.source_id = %L and v.item_type = %L and ct.user_id = %L and ct.variant_count > 0 and %s',
    p_source, p_item_type, p_user,
    case when p_target = 'subtitle'
      then 'ct.subtitle_probed_at is null'
      else 'ct.audio_languages = ''{}''::text[] and (ct.audio_probed_at is null '
           'or ct.audio_probed_at < now() - interval ''180 days'')'
    end);
  if p_untagged_only then
    v_sql := v_sql || ' and ct.version_languages = ''{}''::text[]';
  end if;
  if p_require_tags is not null and coalesce(array_length(p_require_tags, 1), 0) > 0 then
    v_sql := v_sql || format(' and ct.version_languages && %L::text[]', p_require_tags);
  end if;
  v_sql := v_sql || format(' order by ct.release_year desc nulls last, ct.id asc limit %s', v_lim);
  return query execute v_sql;
end;
$fn$;

comment on function public.audio_backfill_candidates is
  'Per-source candidate titles for the audio/subtitle backfill (norva-playback/audio-backfill '
  'runOneDimension sourceId path). Scopes a driving account to one provider panel so multi-panel '
  'accounts can enrich each host in parallel. Audio re-probe window is 180d: deterministic-und '
  'containers stop churning the single connection slot once a panel finishes its first pass. '
  'Recent-first order (release_year desc nulls last, 2026-07-16): probes the titles users '
  'actually open before the archive tail — useful coverage rises faster at equal throughput.';
