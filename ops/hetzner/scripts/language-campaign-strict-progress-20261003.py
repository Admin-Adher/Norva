"""Read-only strict-job evidence for the immutable campaign; aggregate output only."""
import json
import runpy
import uuid

context = runpy.run_path('/home/adrien/.norva/language-campaign-20261003.py')
root = context['ROOT']
manifest = json.loads((root / 'manifest.json').read_text())
start = manifest['startedAt']
rows = []
for source in manifest['sources']:
    owner = str(uuid.UUID(source['userId']))
    sid = str(uuid.UUID(source['id']))
    ids = json.dumps([str(uuid.UUID(v['variantId'])) for v in manifest['variants'] if v['sourceId'] == sid])
    query = f"""with cohort as materialized (
      select value::uuid id from jsonb_array_elements_text('{ids}'::jsonb)
    ), jobs as materialized (
      select j.* from catalog_file_audio_validation_jobs j join cohort c on c.id=j.variant_id
      where j.requested_by='{owner}' and j.source_id='{sid}'
    ) select jsonb_build_object(
      'at',clock_timestamp(),
      'verifiedVariantsSinceStart',(select count(distinct variant_id) from jobs
        where state='verified' and verified_at>='{start}'::timestamptz),
      'verifiedWithProviderProgressSinceStart',(select count(distinct variant_id) from jobs
        where state='verified' and verified_at>='{start}'::timestamptz
        and last_provider_progress_at>='{start}'::timestamptz),
      'verifiedCompleteTrackEvidence',(select count(distinct variant_id) from jobs
        where state='verified' and verified_at>='{start}'::timestamptz
        and next_track_position=cardinality(expected_audio_indices)
        and jsonb_array_length(evidence)=cardinality(expected_audio_indices)),
      'inconclusiveCompletedSinceStart',(select count(distinct variant_id) from jobs
        where state='failed' and error_code='LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE'
        and last_provider_progress_at>='{start}'::timestamptz
        and strict_lid_window_count in (4,6)
        and strict_lid_window_position=strict_lid_window_count
        and jsonb_array_length(strict_lid_window_tokens)=strict_lid_window_count),
      'inconclusiveCompletedMatchingCurrentProfile',(select count(distinct j.variant_id)
        from jobs j join public.catalog_file_tracks cache
          on cache.server_host=j.identity_key and cache.item_type=j.item_type
          and cache.external_id=j.external_id
        where j.state='failed' and j.error_code='LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE'
        and j.last_provider_progress_at>='{start}'::timestamptz
        and j.strict_lid_window_count in (4,6)
        and j.strict_lid_window_position=j.strict_lid_window_count
        and jsonb_array_length(j.strict_lid_window_tokens)=j.strict_lid_window_count
        and cache.observed_profile_fingerprint is not null
        and j.profile_fingerprint is not distinct from cache.observed_profile_fingerprint
        and j.profile_probed_at is not distinct from cache.observed_profile_probed_at
        and j.profile_snapshot is not distinct from cache.observed_profile_snapshot
        and j.file_size_bytes is not distinct from public.vod_language_profile_file_size_bytes(cache.observed_profile_snapshot)),
      'dueUnleased',(select count(*) from jobs where quarantined_at is null and
        ((state='retry_wait' and coalesce(retry_at,'-infinity'::timestamptz)<=now())
        or (state in ('running','finalizing') and lease_expires_at<=now()) or state='queued')),
      'groups',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select state,error_code,count(*) jobs,count(distinct variant_id) variants,
          count(*)filter(where quarantined_at is not null) quarantined,
          min(retry_at) first_retry,max(retry_at) last_retry,
          min(lease_expires_at) first_lease_expiry,max(lease_expires_at) last_lease_expiry,
          max(last_provider_progress_at) last_provider_progress,
          max(updated_at) last_update,max(verified_at) last_verified,
          sum(strict_lid_window_position) stored_window_positions,
          min(provider_attempt_count) min_provider_attempts,max(provider_attempt_count) max_provider_attempts
        from jobs group by state,error_code order by state,error_code
      )x));"""
    result = context['sql'](query)[0]
    result['source'] = source['label']
    rows.append(result)
context['save'](root / 'strict-progress.safe.json', rows)
print(json.dumps(rows))
