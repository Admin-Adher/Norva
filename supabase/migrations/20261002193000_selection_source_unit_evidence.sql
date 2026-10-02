-- The privileged operator compares official aliases, raw provider year/season
-- units and measured duration. SQL fences those receipts to the unchanged
-- public manifest; API ranks and missing metadata never authorize a repair.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $upgrade$
declare definition text; needle text;
begin
 select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure) into definition;
 if position('source_series_season_alias' in definition)>0 then
   raise exception 'Source unit evidence migration already installed' using errcode='55000'; end if;
 needle:='''source_image_filename_exact_alias'',''source_title_prefix_file_duration''';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
   raise exception 'Editorial evidence contract drift' using errcode='55000'; end if;
 definition:=replace(definition,needle,needle||',''source_media_year_alias'',''source_series_season_alias'',''source_alias_file_duration''');
 needle:='editorial:=public.norva_selection_public_editorial_metadata(x->''editorial'');';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
   raise exception 'Editorial source proof insertion contract drift' using errcode='55000'; end if;
 definition:=replace(definition,needle,$proof$
   if x->>'evidence'='source_alias_file_duration' and (
     t.item_type<>'movie'
     or coalesce(public.safe_numeric(x->>'fileDurationSeconds'),0) not between 60 and 28800
     or coalesce(public.safe_numeric(x#>>'{editorial,tmdb,runtime}'),0)<=0
     or abs(public.safe_numeric(x->>'fileDurationSeconds')-60*public.safe_numeric(x#>>'{editorial,tmdb,runtime}'))>90
     or x->>'sourceTitleLabel' is distinct from t.title
     or not exists(select 1 from public.selection_shared_variants sv
       where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
         and sv.playback_hint->>'targetUrl'=x->>'expectedTargetUrl'
         and sv.playback_hint->>'targetUrl' ~* '^https?://')) then
     raise exception 'Alias duration proof no longer matches the public manifest' using errcode='PT409';
   end if;
   if x->>'evidence' in ('source_media_year_alias','source_series_season_alias') then
     if jsonb_typeof(x->'sourceUnits') is distinct from 'array'
       or jsonb_array_length(x->'sourceUnits') not between 1 and 40
       or (x->>'evidence'='source_media_year_alias' and t.item_type<>'movie')
       or (x->>'evidence'='source_series_season_alias' and (t.item_type<>'series'
         or jsonb_typeof(x->'officialSeasons') is distinct from 'array')) then
       raise exception 'Invalid source unit receipt' using errcode='22023';
     end if;
     if exists(select 1 from jsonb_array_elements(x->'sourceUnits') u where
       coalesce(public.safe_numeric(u->>'provider_year'),0) not between 1900 and 2099
       or u->>'provider_group' !~ ('/\s*'||(u->>'provider_year')||'\s*$')
       or not exists(select 1 from public.selection_shared_variants sv join public.selection_shared_media sm
         on sm.release_id=sv.release_id and sm.external_id=u->>'external_id'
         where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
           and sm.title=u->>'title'
           and sm.metadata->'year'=u->'provider_year'
           and sm.metadata->>'selectionVodGroup'=u->>'provider_group'
           and coalesce(sm.metadata->'selectionUnit','null'::jsonb)=coalesce(u->'source_unit','null'::jsonb)
           and ((t.item_type='movie' and sm.item_type='movie' and sv.external_id=sm.external_id)
             or (t.item_type='series' and sm.item_type='episode'
               and sm.metadata->>'selectionParentId'=sv.external_id
               and sm.metadata#>>'{selectionUnit,baseTitle}'=t.title)))) then
       raise exception 'Source units no longer match the public manifest' using errcode='PT409';
     end if;
     if x->>'evidence'='source_media_year_alias' and exists(
       select 1 from jsonb_array_elements(x->'sourceUnits') u where
       coalesce(public.safe_numeric(left(x#>>'{editorial,tmdb,release_date}',4)),0)<1900
       or abs(public.safe_numeric(left(x#>>'{editorial,tmdb,release_date}',4))-public.safe_numeric(u->>'provider_year'))>1) then
       raise exception 'Source movie year and official date disagree' using errcode='PT409';
     end if;
     if x->>'evidence'='source_series_season_alias' then
       if exists(select 1 from jsonb_array_elements(x->'sourceUnits') u where
         jsonb_typeof(u#>'{source_unit,seasons}') is distinct from 'array'
         or jsonb_array_length(u#>'{source_unit,seasons}') not between 1 and 40) then
         raise exception 'Missing source season receipt' using errcode='22023';
       end if;
       if exists(select 1 from jsonb_array_elements(x->'sourceUnits') u
         cross join lateral jsonb_array_elements(u#>'{source_unit,seasons}') sn where
         coalesce(public.safe_numeric(sn#>>'{}'),0)<1
         or not exists(select 1 from jsonb_array_elements(x->'officialSeasons') official
           where official->'season_number'=sn
             and coalesce(public.safe_numeric(left(official->>'air_date',4)),0)>=1900
             and abs(public.safe_numeric(left(official->>'air_date',4))-public.safe_numeric(u->>'provider_year'))<=1)) then
         raise exception 'Source season and official date disagree' using errcode='PT409';
       end if;
     end if;
   end if;
   editorial:=public.norva_selection_public_editorial_metadata(x->'editorial');
 $proof$);
 execute definition;
end $upgrade$;
notify pgrst,'reload schema';
commit;
