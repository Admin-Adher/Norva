-- Movies/Series Audio + Subtitles filters empty despite populated data — root cause + fix.
--
-- Symptom (verified live from the user's own browser): the /media-language-facets endpoint returned
-- a clean 200 with {"audio":[],"subtitles":[]} for adrien.hernandez@outlook.com, an account whose
-- cloud_catalog_facet_summary row holds 70 audio ISO codes and version_tags {multi,vostfr}. The
-- Categories filter worked for the same account, so it was NOT auth / user-id / RLS.
--
-- Root cause: the edge read the summary's audio_langs / version_tags (Postgres text[]) through
-- supabase-js and gated the whole summary block on `Array.isArray(audio_langs) || Array.isArray(
-- version_tags)`. Those text[] columns were NOT surfaced as JS arrays, so the guard was false, the
-- summary block was skipped, and the live .or() fallback also yielded nothing → both menus empty.
-- Genres never hit this because they read a jsonb column (genre_bucket_counts) AND had an RPC
-- fallback (cloud_genre_bucket_counts).
--
-- Fix: compute the facets in SQL and return JSONB (parsed reliably, exactly like genre_bucket_counts).
-- The RPC reads the precomputed summary, falls back to a live distinct-tag scan when it's missing,
-- and applies the same audio/subtitle facet taxonomy the edge used to apply in JS. The edge now just
-- calls this RPC and returns its {audio,subtitles} — no more text[] deserialisation in the hot path.
--
-- Verified live: adrien → 15 audio + French; jeremy → 15 audio + Arabic & French; horizon → 15 + FR.
create or replace function public.cloud_language_facets(p_user_id uuid, p_item_type text)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_audio text[]; v_version text[];
  audio_defs jsonb := '[
    {"id":"fr","label":"French","iso":"fr","tags":["vf","vff","vfq","truefrench","french"]},
    {"id":"en","label":"English","iso":"en","tags":["en","eng","english"]},
    {"id":"es","label":"Spanish","iso":"es","tags":["es","spa","spanish"]},
    {"id":"ar","label":"Arabic","iso":"ar","tags":["ar","ara","arabic"]},
    {"id":"de","label":"German","iso":"de","tags":["de","deu","ger","german"]},
    {"id":"it","label":"Italian","iso":"it","tags":["it","ita","italian"]},
    {"id":"pt","label":"Portuguese","iso":"pt","tags":["pt","por","portuguese"]},
    {"id":"nl","label":"Dutch","iso":"nl","tags":[]},
    {"id":"ru","label":"Russian","iso":"ru","tags":[]},
    {"id":"tr","label":"Turkish","iso":"tr","tags":[]},
    {"id":"pl","label":"Polish","iso":"pl","tags":[]},
    {"id":"hi","label":"Hindi","iso":"hi","tags":[]},
    {"id":"ja","label":"Japanese","iso":"ja","tags":[]},
    {"id":"ko","label":"Korean","iso":"ko","tags":[]},
    {"id":"zh","label":"Chinese","iso":"zh","tags":[]}
  ]'::jsonb;
  sub_defs jsonb := '[
    {"id":"ar","label":"Arabic","tags":["subt_ar","sub_ar","subar","arsub","vostar"]},
    {"id":"fr","label":"French","tags":["vostfr","subfr","frsub","subt_fr","sub_fr"]},
    {"id":"en","label":"English","tags":["vosten","suben","ensub","sub_en"]},
    {"id":"es","label":"Spanish","tags":["vostes","subes","sub_es"]},
    {"id":"de","label":"German","tags":["vostde","subde","sub_de"]},
    {"id":"it","label":"Italian","tags":["vostit","subit","sub_it"]},
    {"id":"pt","label":"Portuguese","tags":["vostpt","subpt","sub_pt"]},
    {"id":"tr","label":"Turkish","tags":["vosttr","subtr","sub_tr"]},
    {"id":"nl","label":"Dutch","tags":["vostnl","subnl","sub_nl"]},
    {"id":"ru","label":"Russian","tags":["vostru","subru","sub_ru"]}
  ]'::jsonb;
  v_audio_set text[]; v_version_set text[];
  v_audio_out jsonb; v_sub_out jsonb;
begin
  -- Prefer the precomputed summary; fall back to a live distinct-tag scan when it's missing.
  select s.audio_langs, s.version_tags into v_audio, v_version
  from public.cloud_catalog_facet_summary s
  where s.user_id = p_user_id and s.item_type = p_item_type;

  if v_audio is null and v_version is null then
    select
      coalesce(array_agg(distinct lower(a.val)) filter (where a.val is not null), '{}'),
      coalesce(array_agg(distinct lower(v.val)) filter (where v.val is not null), '{}')
    into v_audio, v_version
    from public.cloud_titles t
    left join lateral unnest(t.audio_languages)  as a(val) on true
    left join lateral unnest(t.version_languages) as v(val) on true
    where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0;
  end if;

  v_audio_set   := array(select lower(x) from unnest(coalesce(v_audio,   '{}')) x);
  v_version_set := array(select lower(x) from unnest(coalesce(v_version, '{}')) x);

  -- Audio facet present if its ISO is in the audio set OR any of its tags is in the version set.
  select coalesce(jsonb_agg(jsonb_build_object('value', d->>'id', 'label', d->>'label') order by ord), '[]'::jsonb)
  into v_audio_out
  from jsonb_array_elements(audio_defs) with ordinality as e(d, ord)
  where (d->>'iso') = any(v_audio_set)
     or exists (select 1 from jsonb_array_elements_text(d->'tags') tg where tg = any(v_version_set));

  -- Subtitle facet present if any of its tags is in the version set.
  select coalesce(jsonb_agg(jsonb_build_object('value', d->>'id', 'label', d->>'label') order by ord), '[]'::jsonb)
  into v_sub_out
  from jsonb_array_elements(sub_defs) with ordinality as e(d, ord)
  where exists (select 1 from jsonb_array_elements_text(d->'tags') tg where tg = any(v_version_set));

  return jsonb_build_object('audio', v_audio_out, 'subtitles', v_sub_out);
end
$function$;

-- SECURITY INVOKER, service_role only (called by the norva-catalog edge).
revoke all on function public.cloud_language_facets(uuid, text) from public, anon, authenticated;
grant execute on function public.cloud_language_facets(uuid, text) to service_role;
