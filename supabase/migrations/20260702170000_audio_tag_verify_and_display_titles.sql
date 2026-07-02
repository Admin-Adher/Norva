-- Qualité métadonnées (2026-07-02) : deux problèmes remontés depuis le player.
--
-- 1) TAGS AUDIO MENTEURS — « Bêtes de flic » (film FR) affichait une piste « German » : le
--    conteneur du fichier provider est mal tagué à la source, le probe stocke le tag tel quel,
--    et whisper-LID ne tournait QUE sur les pistes non taguées (un tag FAUX était permanent).
--    Mesuré live : 429 titres marqués FR (préfixe FR/VF/(FR)/FRENCH) sondés dont les langues ne
--    contiennent pas fr — dont 30 prétendant « de ». Fix : phase VERIFY dans le mode whisper
--    (norva-playback) — whisper écoute la vraie parole et corrige audio_tracks/audio_languages.
--    Marqueur de convergence ci-dessous (pattern whisper_attempted_at, fenêtre 90 j).

alter table public.cloud_titles add column if not exists audio_lang_verified_at timestamptz;

-- Candidats verify : sondés, avec carte de pistes, jamais vérifiés (le filtre marqueur-FR +
-- langues reste dans la requête ; l'index borne aux lignes non vérifiées, petit et stable).
create index if not exists idx_cloud_titles_audio_verify
  on public.cloud_titles (user_id, item_type, id)
  where audio_probed_at is not null and audio_tracks is not null and audio_lang_verified_at is null;

-- 2) NOMS DE RELEASE ILLISIBLES — « [ Torrent911.me ] Guardians.Of.The.Galaxy.Vol.3.2023... ».
--    Pipeline : cleanDisplayTitle v2 (vod-title-projection.ts) nettoie à l'import ; le front
--    (MediaUtils.cleanReleaseName) nettoie header player + épisodes. identity_key dérive de
--    normalizeTitle(raw) qui strippait déjà tout ça → aucun re-keying, zéro doublon au re-sync.
--    Backfill one-shot des titres existants commençant par un groupe [ ... ] :
with bracket as (
  select id, title,
         trim(regexp_replace(title, '^\s*((\[[^\]]{0,60}\]|\([^\)]{0,60}\))\s*)+', '')) as t1
  from public.cloud_titles
  where title ~ '^\s*[\[(]'
), dedot as (
  select id, title,
         case when t1 !~ '\s' and t1 ~ '^\S+(\.\S+){3,}$' then replace(t1, '.', ' ') else t1 end as t2
  from bracket
), hardcut as (
  select id, title,
         regexp_replace(t2, '\s+(webrip|web-?dl|hdrip|brrip|bdrip|dvdrip|hdtv|hdlight|hdcam|camrip|hdts|blu-?ray|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dts|10bit|8bit|2160p|1080p|720p|480p|4klight)(\s.*)?$', '', 'i') as t3
  from dedot
), softpop as (
  select id, title,
         trim(regexp_replace(regexp_replace(t3,
           '\s+(french|truefrench|vostfr|vost|vff|vfq|vf|vo|multi|subfrench|final|proper|repack|internal|extended|unrated|custom)\s*$', '', 'i'),
           '\s+(french|truefrench|vostfr|vost|vff|vfq|vf|vo|multi|subfrench|final|proper|repack|internal|extended|unrated|custom)\s*$', '', 'i')) as t4
  from hardcut
)
update public.cloud_titles c
set title = s.t4,
    -- les noms propres relancent le matching TMDB (le cron search-match re-tentera vite :
    -- ces titres étaient unmatched parce que la recherche partait du nom pollué)
    search_match_attempted_at = null,
    updated_at = now()
from softpop s
where c.id = s.id and s.t4 <> '' and s.t4 is distinct from c.title;
