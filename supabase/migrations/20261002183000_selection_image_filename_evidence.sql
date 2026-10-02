-- A provider image filename can identify a long truncated label. The operator
-- retains the official aliases; the database also fences that proof to an exact
-- image URL present in this title's unchanged public manifest.
-- Subtitle-prefix evidence additionally requires measured file duration and an
-- unchanged exact public playback URL; the prefix alone is never sufficient.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $upgrade$
declare definition text; needle text;
begin
 select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure) into definition;
 if position('source_image_filename_exact_alias' in definition)>0 then
   raise exception 'Editorial evidence migration already installed' using errcode='55000'; end if;
 needle:='''unique_spacing_or_portuguese_alias'',''unique_source_filename_alias'',''exact_title_unique_file_duration''';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
   raise exception 'Editorial evidence contract drift' using errcode='55000'; end if;
 definition:=replace(definition,needle,needle||',''source_image_filename_exact_alias'',''source_title_prefix_file_duration''');
 needle:='editorial:=public.norva_selection_public_editorial_metadata(x->''editorial'');';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
   raise exception 'Editorial proof insertion contract drift' using errcode='55000'; end if;
 definition:=replace(definition,needle,$proof$
   if x->>'evidence'='source_title_prefix_file_duration' and (
     coalesce(public.safe_numeric(x->>'fileDurationSeconds'),0) not between 60 and 28800
     or length(coalesce(x->>'sourceTitleLabel','')) not between 12 and 512
     or not exists(select 1 from public.selection_shared_variants sv
       where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
         and sv.playback_hint->>'targetUrl'=x->>'expectedTargetUrl'
         and sv.playback_hint->>'targetUrl' ~* '^https?://')) then
     raise exception 'File duration proof no longer matches the public manifest' using errcode='PT409';
   end if;
   if x->>'evidence'='source_image_filename_exact_alias' and (
     length(coalesce(x->>'sourceImageLabel','')) not between 8 and 512
     or coalesce(x->>'expectedManifestPoster','') !~* '^https?://'
     or x->>'expectedManifestPoster' ~* '^https?://image[.]tmdb[.]org(/|$)'
     or not exists(select 1 from public.selection_shared_variants sv
       where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
         and sv.poster_url=x->>'expectedManifestPoster')) then
     raise exception 'Image filename proof no longer matches the public manifest' using errcode='PT409';
   end if;
   editorial:=public.norva_selection_public_editorial_metadata(x->'editorial');
 $proof$);
 execute definition;
end $upgrade$;
notify pgrst,'reload schema';
commit;
