-- The generation-fenced overload starts with (user, source, playback), while
-- the legacy implementation starts with (playback, user, source). All three
-- are UUIDs, so positional forwarding silently passed type checking and then
-- failed ownership validation. Bind by name; retain the active-head/item CAS,
-- transaction-local write proof, and service-role-only execution boundary.
create or replace function public.record_catalog_file_container_observation(
  p_user_id uuid,p_source_id uuid,p_playback_session_id uuid,p_item_type text,
  p_external_id text,p_declared_container text,p_observed_container text,
  p_evidence jsonb,p_expected_media_item_id uuid,p_expected_media_item_updated_at timestamptz,
  p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint
) returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_result jsonb;
begin
  if p_expected_media_item_id is null or p_expected_media_item_updated_at is null then
    raise exception 'container observation item CAS is required' using errcode='22023';
  end if;
  perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,
    p_head_revision,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
  perform set_config('norva.legacy_catalog_source_id',p_source_id::text,true);
  perform set_config('norva.legacy_catalog_user_id',p_user_id::text,true);
  perform set_config('norva.legacy_catalog_generation_id',p_generation_id::text,true);
  perform set_config('norva.legacy_catalog_writer_fenced','on',true);
  v_result:=public.record_catalog_file_container_observation(
    p_playback_session_id => p_playback_session_id,
    p_user_id => p_user_id,
    p_source_id => p_source_id,
    p_item_type => p_item_type,
    p_external_id => p_external_id,
    p_declared_container => p_declared_container,
    p_observed_container => p_observed_container,
    p_evidence => p_evidence,
    p_expected_media_item_id => p_expected_media_item_id,
    p_expected_media_item_updated_at => p_expected_media_item_updated_at
  );
  perform set_config('norva.legacy_catalog_writer_fenced','off',true);
  return v_result;
end
$function$;

revoke all on function public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint) to service_role;
