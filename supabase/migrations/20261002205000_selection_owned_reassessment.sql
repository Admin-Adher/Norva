-- Propagate a separately proved public reassessment to legacy owner fiches.
-- An old rejected ID is removed only when the public writer has archived the
-- exact ID with its independent proof; all unrelated rejections remain active.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $upgrade$
declare d text; needle text;
begin
 select pg_get_functiondef('public.norva_refresh_selection_owned_editorial(uuid,uuid,uuid,int)'::regprocedure) into d;
 if position('independent_public_manifest_reassessment' in d)>0 then
   raise exception 'Owned reassessment already installed' using errcode='55000'; end if;
 needle:=$old$where rejected ~ '^[1-9][0-9]*$') retained)$old$;
 if length(d)-length(replace(d,needle,''))<>length(needle) then
   raise exception 'Owned rejection filter drift'; end if;
 d:=replace(d,needle,$new$where rejected ~ '^[1-9][0-9]*$'
     and not (rejected=t.provider_tmdb_id and exists(
       select 1 from jsonb_array_elements(case when jsonb_typeof(t.metadata#>'{tmdbSearchReview,reassessments}')='array'
         then t.metadata#>'{tmdbSearchReview,reassessments}' else '[]'::jsonb end) proof
       where proof->>'tmdbId'=rejected
         and proof->>'reason'='independent_public_manifest_reassessment'
         and proof->>'evidence' in ('source_media_year_alias','source_series_season_alias',
                                   'source_alias_file_duration','source_original_provider_id')
         and coalesce(proof->>'sourceProofSha256','') ~ '^[a-f0-9]{64}$'))
   ) retained)$new$);
 execute d;
end $upgrade$;
notify pgrst,'reload schema';
commit;
