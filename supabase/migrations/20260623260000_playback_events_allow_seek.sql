-- The app (norva-playback PLAYBACK_EVENT_TYPES) accepts a 'seek' telemetry event
-- — the NorvaEngine emits it with seek timings — and validates every incoming
-- event against that allowlist before inserting. The cloud_playback_events CHECK
-- constraint predates 'seek', so each seek insert violated the constraint and
-- returned 500 (visible in the console as "Playback telemetry failed"). Widen the
-- constraint to match the application's allowlist exactly. Additive + reversible;
-- every existing row already uses one of the prior 10 (still-valid) types, so the
-- new superset constraint validates instantly.
alter table public.cloud_playback_events
  drop constraint if exists cloud_playback_events_event_type_check;

alter table public.cloud_playback_events
  add constraint cloud_playback_events_event_type_check
  check (event_type = any (array[
    'session_created','play_requested','play_started','first_frame',
    'pause','resume','ended','abandoned','playback_error','gateway_error','seek'
  ]::text[]));
