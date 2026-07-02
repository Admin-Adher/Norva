-- Vérification whisper des tags audio menteurs — généralisation (cas « Bhooth Bangla » 2026-07-02).
--
-- Le fichier d'un film HINDI était tagué `bn` (bengali) par le releaser parce que le TITRE contient
-- « Bangla » (= bungalow). La phase verify v1 (migration 20260702170000) ne couvrait que les titres
-- marqués FR sans `fr` — ce pattern « le nom de la langue est un mot du titre » passait au travers.
--
-- 1) RPC `audio_tag_suspects` : centralise la définition des candidats verify (les filtres
--    PostgREST enchaînés devenaient illisibles et la classe 2 exige un mapping code→mots).
--    Classe 1 : marqueur FR dans le titre, pas de fr dans les langues sondées (429 mesurés).
--    Classe 2 : langue sondée UNIQUE dont le nom figure littéralement dans le titre (pattern
--    releaser indien : bangla→bn, hindi→hi, tamil→ta, …). Classe 2 servie en PREMIER (rare +
--    signalée par l'usage réel).
create or replace function public.audio_tag_suspects(
  p_user uuid,
  p_item_type text,
  p_limit int,
  p_retry_before timestamptz
) returns table (
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text,
  audio_tracks jsonb,
  audio_languages text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.default_variant_id, t.provider_tmdb_id, t.audio_tracks, t.audio_languages
  from public.cloud_titles t
  where t.user_id = p_user
    and t.item_type = p_item_type
    and t.variant_count > 0
    and t.audio_probed_at is not null
    and t.audio_tracks is not null
    and coalesce(array_length(t.audio_languages, 1), 0) > 0
    and (t.audio_lang_verified_at is null or t.audio_lang_verified_at < p_retry_before)
    and (
      -- classe 2 (title-word) OU classe 1 (FR-marked sans fr)
      ( array_length(t.audio_languages, 1) = 1 and exists (
          select 1 from (values
            ('bn', '(bangla|bengali)'), ('hi', 'hindi'),   ('ta', 'tamil'),
            ('te', 'telugu'),           ('ml', 'malayalam'), ('ur', 'urdu'),
            ('kn', 'kannada'),          ('pa', 'punjabi'),  ('mr', 'marathi'),
            ('gu', 'gujarati'),         ('tr', 'turkish')
          ) as m(code, words)
          where t.audio_languages[1] = m.code
            and t.title ~* ('\m' || m.words || '\M')
      ) )
      or
      ( (t.title ~* '^(fr|vf|vff|truefrench)[ \-▎|]' or t.title ~* '\((fr|vf)\)' or t.title ~* 'french')
        and not (t.audio_languages @> array['fr']) )
    )
  order by
    (array_length(t.audio_languages, 1) = 1 and not (t.audio_languages @> array['fr'])
       and t.title !~* 'french') desc,   -- classe 2 d'abord (approximation stable et cheap)
    t.id
  limit p_limit;
$$;

revoke all on function public.audio_tag_suspects(uuid, text, int, timestamptz) from anon, authenticated;

-- 2) Crons whisper NUIT pour les 5 panels AÎRO — trou de couverture découvert par ce cas :
--    AÎRO n'avait AUCUN cron whisper (LID des pistes non taguées jamais faite, verify jamais
--    exécutée). Offsets cycle-9 sans collision avec les crons nuit existants du compte
--    (ninja séries 0-59/9 + subtitle 3-59/9 ; promax séries 1-59/9 + subtitle 4-59/9) ;
--    chaque panel = host distinct → un seul accès provider par host à la fois, comme le design v3.
select cron.schedule('norva-whisper-airo-ninja', '6-59/9 0-5 * * *', $cron$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','976e7bbd-f433-4a41-821d-3cb983c73921','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds:=110000);
$cron$);
select cron.schedule('norva-whisper-airo-promax', '7-59/9 0-5 * * *', $cron$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','3eb5999e-117b-4196-aaaf-4304e80a48ff','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds:=110000);
$cron$);
select cron.schedule('norva-whisper-airo-airysat', '2-59/9 0-5 * * *', $cron$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','f660f738-dbd6-43f8-acc0-b91784bfa138','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds:=110000);
$cron$);
select cron.schedule('norva-whisper-airo-king365', '5-59/9 0-5 * * *', $cron$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','4e3d7dd8-9123-4bd6-9a02-36cc92e40a33','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds:=110000);
$cron$);
select cron.schedule('norva-whisper-airo-opplex', '8-59/9 0-5 * * *', $cron$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','9579e61b-5cda-4ea2-8b40-7996de8af32a','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds:=110000);
$cron$);

-- 3) One-shot auto-nettoyant : « IN ▎ Turbo » (Promax, tagué bn SANS mot du titre → hors classe 2)
--    vérifié explicitement cette nuit à 02:53 UTC (minute libre du grid Promax), puis le job se
--    déprogramme lui-même. Si le tick est skippé (session live), relancer manuellement.
select cron.schedule('norva-oneshot-verify-turbo', '53 2 * * *', $cron$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','3eb5999e-117b-4196-aaaf-4304e80a48ff','type','movie','mode','whisper','limit',1,'concurrency',1,'verifyTitleIds',jsonb_build_array('00f32967-5209-426d-a9a3-00d0bbc72f17')),
    timeout_milliseconds:=110000);
  select cron.unschedule('norva-oneshot-verify-turbo');
$cron$);
