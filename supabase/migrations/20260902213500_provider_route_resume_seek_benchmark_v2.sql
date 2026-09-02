begin;

alter table public.provider_route_policies
  add column if not exists resume_probe_bytes integer not null default 1048576;

alter table public.provider_route_policies
  drop constraint if exists provider_route_policies_resume_probe_bytes_check;

alter table public.provider_route_policies
  add constraint provider_route_policies_resume_probe_bytes_check
  check (resume_probe_bytes between 262144 and 4194304);

alter table public.provider_route_measurements
  add column if not exists range_start_bytes bigint not null default 0;

alter table public.provider_route_measurements
  drop constraint if exists provider_route_measurements_phase_check;

alter table public.provider_route_measurements
  add constraint provider_route_measurements_phase_check
  check (phase in ('tiny', 'sustained', 'resume-seek', 'real-playback'));

alter table public.provider_route_measurements
  drop constraint if exists provider_route_measurements_range_start_check;

alter table public.provider_route_measurements
  add constraint provider_route_measurements_range_start_check
  check (
    range_start_bytes between 0 and 137438953471
    and (
      (phase in ('tiny', 'sustained', 'real-playback') and range_start_bytes = 0)
      or (phase = 'resume-seek' and range_start_bytes > 0)
    )
  );

-- Route state learned by v1 contains no proof that non-zero byte ranges work.
-- Expire it without deleting the historical measurements; the next idle v2
-- benchmark must earn a fresh account- and host-level recommendation.
update public.provider_route_state
set expires_at = greatest(selected_at + interval '1 second', clock_timestamp()),
    version = version + 1,
    updated_at = clock_timestamp()
where expires_at > clock_timestamp();

comment on column public.provider_route_policies.resume_probe_bytes is
  'Bounded byte count used for each non-zero resume-range route probe.';

comment on column public.provider_route_measurements.range_start_bytes is
  'Requested provider byte offset; zero for prefix probes and non-zero for resume evidence.';

commit;
