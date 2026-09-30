-- Rollback-only runtime regression. Caller supplies norva.test_job_id and
-- wraps this file plus the candidate migration in BEGIN ... ROLLBACK.
set local request.jwt.claim.role='service_role';
do $test$
declare
 j public.cloud_source_credential_transition_jobs%rowtype;
 c public.cloud_source_catalog_title_refresh_checkpoints%rowtype;
 snapshot jsonb; run jsonb; payload jsonb; bad jsonb; result jsonb;
 epoch bigint; selected_title uuid; failure_detail text;
begin
 select * into strict j from public.cloud_source_credential_transition_jobs
 where id=current_setting('norva.test_job_id')::uuid for update;
 if j.state<>'processing' or j.lease_until<=now() then raise exception 'fixture requires a live lease'; end if;
 select * into strict c from public.cloud_source_catalog_title_refresh_checkpoints where job_id=j.id;
 snapshot:=public.norva_get_catalog_write_snapshot(j.source_id,j.user_id);
 select visibility_epoch into epoch from public.cloud_user_catalog_visibility_epochs where user_id=j.user_id;
 run:=public.norva_begin_active_catalog_title_projection_refresh(j.source_id,j.user_id,c.generation_id,
 j.id,j.lease_owner,j.lease_sequence,c.head_revision,c.config_revision,c.source_visibility_epoch,epoch);
 select p.title_id,jsonb_build_array(jsonb_build_object('itemType',p.item_type,'identityKey',p.identity_key,
 'titleId',p.title_id,'payloadUpdatedAt',p.updated_at)) into selected_title,payload
 from public.cloud_source_catalog_generation_candidate_titles p
 where p.generation_id=c.generation_id and p.user_id=j.user_id and p.source_id=j.source_id
 and exists(select 1 from public.cloud_title_variants v where v.generation_id=p.generation_id
   and v.title_id=p.title_id and v.projection_refresh_run_id=c.refresh_run_id)
 and exists(select 1 from public.cloud_title_variants v where v.generation_id=p.generation_id
   and v.title_id=p.title_id and v.projection_refresh_run_id is distinct from c.refresh_run_id)
 limit 1;
 if payload is null then raise exception 'fixture requires a title split across refreshed and pending variants'; end if;
 bad:=jsonb_set(payload,'{0,payloadUpdatedAt}',to_jsonb('2000-01-01T00:00:00Z'::text));
 begin
  perform public.norva_confirm_active_catalog_title_projection_batch(j.source_id,j.user_id,c.generation_id,
   c.refresh_run_id,j.id,j.lease_owner,j.lease_sequence,c.head_revision,c.config_revision,
   c.source_visibility_epoch,epoch,bad);
  raise exception 'stale payload accepted';
 exception when sqlstate 'PT409' then null; end;
 result:=public.norva_confirm_active_catalog_title_projection_batch(j.source_id,j.user_id,c.generation_id,
   c.refresh_run_id,j.id,j.lease_owner,j.lease_sequence,c.head_revision,c.config_revision,
   c.source_visibility_epoch,epoch,payload);
 if (result->>'confirmedTitles')::int<>1 then raise exception 'page payload not confirmed'; end if;
 begin
  perform public.norva_mark_active_catalog_title_projection_refreshed(j.source_id,j.user_id,c.generation_id,
   c.refresh_run_id,j.id,j.lease_owner,j.lease_sequence,c.head_revision,c.config_revision,
   c.source_visibility_epoch,epoch);
  raise exception 'incomplete inventory finalized';
 exception when sqlstate 'PT409' or sqlstate '40001' or sqlstate '55000' then
  get stacked diagnostics failure_detail=message_text;
  if failure_detail<>'active title projection marker job lease CAS failed' then raise; end if;
  if j.title_inventory_completed_at is not null or j.title_prune_completed_at is not null then
   raise exception 'fixture must lack final inventory proof'; end if;
 end;
 raise notice 'page confirmation passed; stale payload and premature completion rejected';
end
$test$;
