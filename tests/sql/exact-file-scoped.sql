set request.jwt.claim.role='service_role';
select public.metadata_rollout_assert(not public.catalog_language_exact_file_enabled_for_source(null,null),'exact_null_denied');
select public.metadata_rollout_assert(not has_function_privilege('authenticated','public.claim_provider_exact_file_probe_for_source(uuid,uuid,text,text,text,text,text,integer)','execute'),'exact_client_denied');
select public.metadata_rollout_assert(not has_table_privilege('service_role','public.catalog_language_exact_file_rollout','update'),'exact_direct_rollout_write_denied');
do $test$
declare u uuid; other_user uuid; ident text; rev bigint:=0; points integer;
begin
 select id into u from auth.users order by id limit 1;
 select id into other_user from auth.users where id<>u order by id limit 1;
 ident:='source:'||u::text;
 insert into public.cloud_catalog_visible_title_variants values(u,u,'movie','a'),(u,u,'movie','b');
 insert into public.provider_account_language_validation_leases values(repeat('a',64),'holder',now()+interval '3 minutes');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','a',repeat('a',64),'holder',180),'exact_install_inert');
 begin
  perform public.set_catalog_language_exact_file_rollout(0,500,'fixture stage skip refused');
  raise exception 'stage skip accepted';
 exception when invalid_parameter_value then null; end;
 foreach points in array array[100,500,2000,5000,10000] loop
  perform public.set_catalog_language_metadata_rollout(rev,points,'fixture metadata prerequisite stage');
  perform public.set_catalog_language_exact_file_rollout(rev,points,'fixture exact-file rollout stage');
  rev:=rev+1;
 end loop;
 perform public.metadata_rollout_assert(public.catalog_language_exact_file_enabled_for_source(u,u),'exact_eligible_owner');
 perform public.metadata_rollout_assert(not public.catalog_language_exact_file_enabled_for_source(other_user,u),'exact_cross_owner_gate');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(other_user,u,ident,'movie','a',repeat('a',64),'holder',180),'exact_cross_owner_claim');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','missing',repeat('a',64),'holder',180),'exact_unowned_file');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,'wrong','movie','a',repeat('a',64),'holder',180),'exact_identity_binding');
 insert into public.provider_file_probe_leases values(ident,'legacy',now()+interval '1 minute');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','a',repeat('a',64),'holder',180),'exact_legacy_conflict');
 delete from public.provider_file_probe_leases;
 perform public.metadata_rollout_assert(public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','a',repeat('a',64),'holder',180),'exact_movie_claim');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','b',repeat('a',64),'holder',180),'exact_single_account');
 perform public.metadata_rollout_assert(not public.release_provider_exact_file_probe(ident,'movie','a','wrong'),'exact_release_owner');
 perform public.release_provider_exact_file_probe(ident,'movie','a','holder');
 insert into public.cloud_playback_sessions values(repeat('a',64),'pending',now()+interval '1 minute');
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','a',repeat('a',64),'holder',180),'exact_viewer_priority');
 delete from public.cloud_playback_sessions;
 update public.cloud_sources set enabled=false where id=u;
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'movie','a',repeat('a',64),'holder',180),'exact_disabled_source');
 update public.cloud_sources set enabled=true where id=u;
 insert into public.catalog_file_audio_validation_jobs values(u,u,ident,'episode','ep','running',now()+interval '1 minute',null);
 update public.fixture_visibility set visible=false;
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'episode','ep',repeat('a',64),'holder',180),'exact_hidden_source_job_denied');
 update public.fixture_visibility set visible=true;
 perform public.metadata_rollout_assert(public.claim_provider_exact_file_probe_for_source(u,u,ident,'episode','ep',repeat('a',64),'holder',180),'exact_episode_job');
 perform public.release_provider_exact_file_probe(ident,'episode','ep','holder');
 update public.catalog_file_audio_validation_jobs set quarantined_at=now();
 perform public.metadata_rollout_assert(not public.claim_provider_exact_file_probe_for_source(u,u,ident,'episode','ep',repeat('a',64),'holder',180),'exact_quarantine');
 perform public.set_catalog_language_exact_file_rollout(rev,0,'fixture emergency rollback to zero');
 perform public.metadata_rollout_assert(not public.catalog_language_exact_file_enabled_for_source(u,u),'exact_rollback');
 begin
  perform public.set_catalog_language_exact_file_rollout(rev,100,'fixture stale revision rejected');
  raise exception 'stale revision accepted';
 exception when sqlstate 'PT409' then null; end;
end $test$;
