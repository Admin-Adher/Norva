-- Rollback-only runtime fixture. Caller sets norva.test_job_id to a live refresh job.
begin;
set local request.jwt.claim.role='service_role';

set local statement_timeout='8s';
set local lock_timeout='3s';
do $test$
declare j public.cloud_source_credential_transition_jobs%rowtype; c public.cloud_source_catalog_title_refresh_checkpoints%rowtype; e bigint; cv bigint; payload jsonb; r jsonb;
begin
perform 1 from cloud_source_transitions where id=(select transition_id from cloud_source_credential_transition_jobs where id=current_setting('norva.test_job_id')::uuid) for update;
select * into strict j from cloud_source_credential_transition_jobs where id=current_setting('norva.test_job_id')::uuid;
if j.state<>'processing' or j.lease_until<=now() then raise exception 'live lease needed'; end if;
select * into strict c from cloud_source_catalog_title_refresh_checkpoints where job_id=j.id;
select visibility_epoch into e from cloud_user_catalog_visibility_epochs where user_id=j.user_id;
select jsonb_agg(x.payload),max(x.catalog_version) into payload,cv from (
select (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(v)) where key=any(array['title_id','media_item_id','item_type','external_id','raw_title','label','language','quality','resolution','container_extension','poster_url','playback_hint','codec_profile','compatibility_tier','playback_cost_score','last_observed_ttff_ms','observed_success_rate','metadata'])) payload,m.catalog_version
from cloud_title_variants v join cloud_media_items m on m.id=v.media_item_id where v.generation_id=c.generation_id and v.item_type='movie' and v.projection_refresh_run_id=c.refresh_run_id and m.projection_refresh_run_id=c.refresh_run_id limit 50)x;
r:=public.norva_upsert_active_catalog_title_variants(j.source_id,j.user_id,c.generation_id,c.refresh_run_id,j.id,j.lease_owner,j.lease_sequence,c.head_revision,c.config_revision,c.source_visibility_epoch,e,cv,payload);
if (r->>'writtenVariants')::int<>50 then raise exception 'valid batch count'; end if;
select visibility_epoch into e from cloud_user_catalog_visibility_epochs where user_id=j.user_id;
payload:=jsonb_set(payload,'{0,media_item_id}',to_jsonb(gen_random_uuid()::text));
begin
 perform public.norva_upsert_active_catalog_title_variants(j.source_id,j.user_id,c.generation_id,c.refresh_run_id,j.id,j.lease_owner,j.lease_sequence,c.head_revision,c.config_revision,c.source_visibility_epoch,e,cv,payload);
 raise exception 'missing parent accepted';
exception when sqlstate 'PT409' then null;
end;
raise notice 'Valid 50-row batch accepted; missing parent rejected';
end $test$;

rollback;
