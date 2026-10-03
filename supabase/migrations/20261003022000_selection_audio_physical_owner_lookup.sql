begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
-- These two queue functions join cloud_media_items (physical rows), so expanding
-- virtual shared variants for every enrolled owner adds no canonical physical
-- source. Reuse the existing physical view with identical visibility/generation
-- gates. Do not replace the catalogue view used by application reads.
do $f$
declare signature text; definition text;
begin
  foreach signature in array array['public.selection_audio_job_owners(text,text)',
    'public.seed_selection_audio_jobs(jsonb)'] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if position('public.cloud_catalog_visible_title_variants' in definition)=0
      or position('public.cloud_media_items media' in definition)=0 then
      raise exception 'SELECTION_AUDIO_PHYSICAL_OWNER_SOURCE_DRIFT';
    end if;
    execute replace(definition,'public.cloud_catalog_visible_title_variants',
      'public.selection_shared_runtime_physical_variants');
  end loop;
end $f$;
commit;
