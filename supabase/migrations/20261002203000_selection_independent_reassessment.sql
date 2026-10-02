-- Original source IDs are independent of enriched title recipes. A prior
-- automatic rejection can be reassessed only with stronger manifest evidence;
-- its history is archived, never erased, and ordinary reuse remains fenced.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $upgrade$
declare d text; needle text;
begin
 select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure) into d;
 if position('independent_public_manifest_reassessment' in d)>0 then
   raise exception 'Independent reassessment already installed' using errcode='55000'; end if;
 needle:='rejected jsonb;';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Audit declaration drift'; end if;
 d:=replace(d,needle,needle||' reassessed jsonb;');
 needle:='''source_alias_file_duration''';
 -- This literal occurs both in its duration fence and in the allowlist.
 if length(d)-length(replace(d,needle,''))<>2*length(needle) then raise exception 'Audit evidence drift'; end if;
 d:=replace(d,'''source_series_season_alias'',''source_alias_file_duration''',
              '''source_series_season_alias'',''source_alias_file_duration'',''source_original_provider_id''');
 needle:='editorial:=public.norva_selection_public_editorial_metadata(x->''editorial'');';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Audit insertion drift'; end if;
 d:=replace(d,needle,$proof$
   if x->>'evidence'='source_original_provider_id' then
     if jsonb_typeof(x->'originalIdUnits') is distinct from 'array'
       or jsonb_array_length(x->'originalIdUnits') not between 1 and 500
       or exists(select 1 from jsonb_array_elements(x->'originalIdUnits') u where
         u->>'providerId' is distinct from x->>'tmdbId'
         or not exists(select 1 from public.selection_shared_variants sv join public.selection_shared_media sm
           on sm.release_id=sv.release_id and sm.external_id=u->>'externalId'
           where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
             and (sm.external_id=sv.external_id or (t.item_type='series' and sm.metadata->>'selectionParentId'=sv.external_id))
             and sm.metadata->>'providerTmdbId'=x->>'tmdbId'))
       or exists(select 1 from public.selection_shared_variants sv join public.selection_shared_media sm
         on sm.release_id=sv.release_id and (sm.external_id=sv.external_id
           or (t.item_type='series' and sm.metadata->>'selectionParentId'=sv.external_id))
         where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
           and sm.metadata->>'providerTmdbId' is distinct from x->>'tmdbId') then
       raise exception 'Original provider ID receipt no longer matches every source variant' using errcode='PT409';
     end if;
   end if;
   if x->>'evidence'='source_poster_confirmed' and x ? 'originalPosterUnits' then
     if jsonb_typeof(x->'originalPosterUnits') is distinct from 'array'
       or jsonb_array_length(x->'originalPosterUnits') not between 1 and 500
       or exists(select 1 from jsonb_array_elements(x->'originalPosterUnits') u where
         not exists(select 1 from public.selection_shared_variants sv join public.selection_shared_media sm
           on sm.release_id=sv.release_id and sm.external_id=u->>'externalId'
           where sv.release_id=p_release and sv.item_type=t.item_type and sv.identity_key=t.identity_key
             and (sm.external_id=sv.external_id or (t.item_type='series' and sm.metadata->>'selectionParentId'=sv.external_id))
             and sm.poster_url=u->>'poster' and sm.poster_url ~ '^https://image[.]tmdb[.]org/t/p/[^/]+/[^/]+[.](jpg|png|webp)$')) then
       raise exception 'Original provider artwork receipt no longer matches the public manifest' using errcode='PT409';
     end if;
   end if;
   editorial:=public.norva_selection_public_editorial_metadata(x->'editorial');
 $proof$);
 needle:='rejected:=coalesce(t.metadata#>''{tmdbSearchReview,rejectedTmdbIds}'',''[]'');';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Audit rejection initialization drift'; end if;
 d:=replace(d,needle,needle||' reassessed:=coalesce(t.metadata#>''{tmdbSearchReview,reassessments}'',''[]''::jsonb);');
 needle:=$old$   if x->>'action'='verified' and rejected @> jsonb_build_array(next_id) then
     raise exception 'Previously rejected identity requires separate review' using errcode='22023'; end if;$old$;
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Audit rejection gate drift'; end if;
 d:=replace(d,needle,$review$
   if x->>'action'='verified' and rejected @> jsonb_build_array(next_id) then
     if t.provider_tmdb_id is not null
       or t.metadata#>>'{tmdbValidation,reason}' is distinct from 'public_title_alias_mismatch'
       or t.metadata#>>'{tmdbSearchReview,reason}' is distinct from 'old_id_rejected'
       or x->>'evidence' not in ('source_media_year_alias','source_series_season_alias',
                                'source_alias_file_duration','source_original_provider_id')
       or x#>>'{rejectionReassessment,reason}' is distinct from 'independent_public_manifest_reassessment'
       or x#>'{rejectionReassessment,previousReview}' is distinct from t.metadata->'tmdbSearchReview'
       or coalesce(x#>>'{rejectionReassessment,sourceProofSha256}','') !~ '^[a-f0-9]{64}$' then
       raise exception 'Previously rejected identity requires separate review' using errcode='22023';
     end if;
     reassessed:=reassessed||jsonb_build_array(jsonb_build_object('tmdbId',next_id,
       'previousReview',t.metadata->'tmdbSearchReview','previousValidation',t.metadata->'tmdbValidation',
       'reason','independent_public_manifest_reassessment','evidence',x->>'evidence',
       'sourceProofSha256',x#>>'{rejectionReassessment,sourceProofSha256}','reviewedAt',statement_timestamp()));
     select coalesce(jsonb_agg(v),'[]'::jsonb) into rejected from jsonb_array_elements(rejected) v
       where v is distinct from to_jsonb(next_id);
   end if;
 $review$);
 needle:='''reason'',x->>''evidence'',''reviewedAt'',statement_timestamp()';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Audit history write drift'; end if;
 d:=replace(d,needle,needle||',''reassessments'',reassessed');
 execute d;
end $upgrade$;
notify pgrst,'reload schema';
commit;
