-- Read-only deployment preflight. No provider request, account ID or credential
-- is returned. This tests prerequisites, not deployment or actual enrichment.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT jsonb_build_object(
  'checked_at', clock_timestamp(),
  'job_origin_exists', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='catalog_file_audio_validation_jobs'
      AND column_name='request_origin' AND is_nullable='NO'
  ),
  'job_rls_enabled', (SELECT relrowsecurity FROM pg_class
    WHERE oid='public.catalog_file_audio_validation_jobs'::regclass),
  'service_can_read_origin', has_column_privilege('service_role',
    'public.catalog_file_audio_validation_jobs','request_origin','SELECT'),
  'automatic_start_server_only', (SELECT bool_and(
    has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
  ) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='start_automatic_catalog_file_audio_validation_job'),
  'public_cannot_write_origin', (SELECT bool_and(
    NOT has_column_privilege(role_name,'public.catalog_file_audio_validation_jobs','request_origin','UPDATE')
    AND NOT has_column_privilege(role_name,'public.catalog_file_audio_validation_jobs','request_origin','INSERT')
  ) FROM (VALUES ('anon'),('authenticated')) AS roles(role_name))
);
WITH sources AS MATERIALIZED (
  SELECT s.id,s.user_id,p.status
  FROM public.cloud_sources s
  JOIN public.cloud_source_catalog_heads h ON h.source_id=s.id AND h.user_id=s.user_id
  JOIN auth.users u ON u.id=s.user_id
  LEFT JOIN public.cloud_entitlement_projection p ON p.user_id=s.user_id
  WHERE s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
    AND h.active_generation_id IS NOT NULL
    AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
    AND public.norva_source_catalog_visible_internal(s.id,s.user_id)
)
SELECT jsonb_build_object(
  'checked_at',clock_timestamp(),
  'current_ready_sources',count(*),
  'current_owners',count(DISTINCT user_id),
  'without_projection_sources',count(*) FILTER(WHERE status IS NULL),
  'without_projection_owners',count(DISTINCT user_id) FILTER(WHERE status IS NULL),
  'hard_blocked_sources',count(*) FILTER(WHERE status IN ('revoked','refunded','fraud')),
  'enrichment_eligible_sources',count(*) FILTER(WHERE status IS NULL OR status IN
    ('trialing','active','grace','past_due','cancelled_at_period_end','expired','unknown'))
) FROM sources;
ROLLBACK;
