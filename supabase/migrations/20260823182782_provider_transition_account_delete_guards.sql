begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_sources;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_sources for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_lifecycle;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_lifecycle for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_provider_access;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_provider_access for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_heads;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_heads for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_transitions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_transitions for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generations;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generations for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_media_items;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_media_items for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_title_variants;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_title_variants for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_live_logical_channels;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_live_logical_channels for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_live_variants;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_live_variants for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_series_episode_memberships;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_series_episode_memberships for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_series_inventory_state;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_series_inventory_state for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_catalog_background_owner_build_jobs;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_catalog_background_owner_build_jobs for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_catalog_background_owner_snapshots;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_catalog_background_owner_snapshots for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_catalog_background_owner_snapshot_sources;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_catalog_background_owner_snapshot_sources for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_catalog_background_owner_snapshot_rows;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_catalog_background_owner_snapshot_rows for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_catalog_background_owner_pointers;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_catalog_background_owner_pointers for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_title_refresh_actions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_title_refresh_actions for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_title_refresh_checkpoints;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_title_refresh_checkpoints for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_manifest_seal_progress;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_manifest_seal_progress for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generation_candidate_titles;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generation_candidate_titles for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generation_title_promotions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generation_title_promotions for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generation_inventory_actions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generation_inventory_actions for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generation_episode_copy;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generation_episode_copy for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generation_category_lists;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generation_category_lists for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_catalog_generation_categories;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_catalog_generation_categories for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_titles;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_titles for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_title_file_language_observations;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_title_file_language_observations for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_title_overrides;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_title_overrides for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_title_rating_operations;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_title_rating_operations for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_title_ratings;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_title_ratings for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_favorites;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_favorites for each row execute function public.norva_provider_account_delete_write_guard();

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_playback_events;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_playback_events for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.paywall_funnel_events;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.paywall_funnel_events for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_watch_history;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_watch_history for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_enrichment_source_schedule;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_enrichment_source_schedule for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_source_provider_identities;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_source_provider_identities for each row execute function public.norva_provider_account_delete_write_guard();

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_file_audio_validation_jobs;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_file_audio_validation_jobs for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_episode_probe_state;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_episode_probe_state for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.catalog_provider_inventory_backoff;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.catalog_provider_inventory_backoff for each row execute function public.norva_provider_account_delete_write_guard();

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_transition_secrets;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_transition_secrets for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_credential_transition_jobs;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_credential_transition_jobs for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_credential_transition_actions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_credential_transition_actions for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_identity_assessments;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_identity_assessments for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_lifecycle_events;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_lifecycle_events for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_source_direct_fallback_leases;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_source_direct_fallback_leases for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_provider_call_permits;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_provider_call_permits for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_playback_sessions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_playback_sessions for each row execute function public.norva_provider_account_delete_write_guard();
drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_gateway_sessions;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_gateway_sessions for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_aaa_provider_account_delete_write_guard on public.cloud_relay_tokens;
create trigger trg_aaa_provider_account_delete_write_guard before insert or update or delete on public.cloud_relay_tokens for each row execute function public.norva_provider_account_delete_write_guard();
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Split append-only guards so the exact leased batch/auth-delete transaction
-- can drain them.  Ordinary writes and deletes keep their historical guards.
drop trigger if exists trg_cloud_source_transitions_guard
  on public.cloud_source_transitions;
drop trigger if exists trg_cloud_source_transitions_guard_u
  on public.cloud_source_transitions;
drop trigger if exists trg_cloud_source_transitions_guard_d
  on public.cloud_source_transitions;
create trigger trg_cloud_source_transitions_guard
before insert on public.cloud_source_transitions
for each row execute function public.norva_cloud_source_transition_guard();
create trigger trg_cloud_source_transitions_guard_u
before update on public.cloud_source_transitions
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_cloud_source_transition_guard();
create trigger trg_cloud_source_transitions_guard_d
before delete on public.cloud_source_transitions
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_cloud_source_transition_guard();

drop trigger if exists trg_cloud_source_transition_fingerprint_guard
  on public.cloud_source_transitions;
create trigger trg_cloud_source_transition_fingerprint_guard
before update on public.cloud_source_transitions
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_credential_transition_fingerprint_guard();

drop trigger if exists trg_cloud_source_identity_assessments_guard
  on public.cloud_source_identity_assessments;
drop trigger if exists trg_cloud_source_identity_assessments_guard_d
  on public.cloud_source_identity_assessments;
create trigger trg_cloud_source_identity_assessments_guard
before update on public.cloud_source_identity_assessments
for each row execute function
  public.norva_cloud_source_identity_assessment_guard();
create trigger trg_cloud_source_identity_assessments_guard_d
before delete on public.cloud_source_identity_assessments
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_cloud_source_identity_assessment_guard();

drop trigger if exists trg_cloud_source_lifecycle_events_append_only
  on public.cloud_source_lifecycle_events;
drop trigger if exists trg_cloud_source_lifecycle_events_append_only_d
  on public.cloud_source_lifecycle_events;
create trigger trg_cloud_source_lifecycle_events_append_only
before update on public.cloud_source_lifecycle_events
for each row execute function
  public.norva_cloud_source_lifecycle_events_append_only();
create trigger trg_cloud_source_lifecycle_events_append_only_d
before delete on public.cloud_source_lifecycle_events
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_cloud_source_lifecycle_events_append_only();

drop trigger if exists trg_cloud_source_transition_secrets_guard
  on public.cloud_source_transition_secrets;
drop trigger if exists trg_cloud_source_transition_secrets_guard_d
  on public.cloud_source_transition_secrets;
create trigger trg_cloud_source_transition_secrets_guard
before insert or update on public.cloud_source_transition_secrets
for each row execute function public.norva_credential_secret_guard();
create trigger trg_cloud_source_transition_secrets_guard_d
before delete on public.cloud_source_transition_secrets
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_credential_secret_guard();

drop trigger if exists trg_cloud_source_credential_jobs_guard
  on public.cloud_source_credential_transition_jobs;
drop trigger if exists trg_cloud_source_credential_jobs_guard_d
  on public.cloud_source_credential_transition_jobs;
create trigger trg_cloud_source_credential_jobs_guard
before insert or update on public.cloud_source_credential_transition_jobs
for each row execute function public.norva_credential_job_guard();
create trigger trg_cloud_source_credential_jobs_guard_d
before delete on public.cloud_source_credential_transition_jobs
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_credential_job_guard();

drop trigger if exists trg_cloud_source_credential_actions_guard
  on public.cloud_source_credential_transition_actions;
drop trigger if exists trg_cloud_source_credential_actions_guard_d
  on public.cloud_source_credential_transition_actions;
create trigger trg_cloud_source_credential_actions_guard
before insert or update on public.cloud_source_credential_transition_actions
for each row execute function public.norva_credential_action_guard();
create trigger trg_cloud_source_credential_actions_guard_d
before delete on public.cloud_source_credential_transition_actions
for each row
when (not public.norva_provider_account_delete_fenced(old.user_id))
execute function public.norva_credential_action_guard();

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists trg_auth_users_provider_transition_cleanup on auth.users;
drop trigger if exists trg_auth_users_provider_transition_guard on auth.users;
create trigger trg_auth_users_provider_transition_guard
before delete on auth.users
for each row execute function
  public.norva_provider_transition_account_delete_guard();

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';


drop trigger if exists trg_cloud_sources_provider_transition_delete_guard
  on public.cloud_sources;
create trigger trg_cloud_sources_provider_transition_delete_guard
before delete on public.cloud_sources
for each row execute function
  public.norva_provider_transition_source_delete_guard();
commit;
