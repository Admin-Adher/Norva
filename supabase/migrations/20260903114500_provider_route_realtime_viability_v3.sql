begin;

alter table public.provider_route_policies
  add column if not exists realtime_throughput_margin numeric(4,2) not null default 1.35;

alter table public.provider_route_policies
  drop constraint if exists provider_route_policies_realtime_throughput_margin_check;

alter table public.provider_route_policies
  add constraint provider_route_policies_realtime_throughput_margin_check
  check (realtime_throughput_margin between 1.10 and 3.00);

alter table public.provider_route_policies
  alter column resume_probe_bytes set default 8388608;

alter table public.provider_route_policies
  drop constraint if exists provider_route_policies_resume_probe_bytes_check;

update public.provider_route_policies
set resume_probe_bytes = greatest(resume_probe_bytes, 8388608),
    updated_at = clock_timestamp();

alter table public.provider_route_policies
  add constraint provider_route_policies_resume_probe_bytes_check
  check (resume_probe_bytes between 4194304 and 16777216);

alter table public.provider_route_measurements
  add column if not exists minimum_required_bytes_per_second bigint not null default 0;

alter table public.provider_route_measurements
  drop constraint if exists provider_route_measurements_minimum_required_throughput_check;

alter table public.provider_route_measurements
  add constraint provider_route_measurements_minimum_required_throughput_check
  check (minimum_required_bytes_per_second between 0 and 10737418240);

-- V1/V2 state has no proof that a deep byte range can sustain the media's
-- actual average bitrate. Preserve all telemetry, but require the next idle
-- V3 benchmark to earn a recommendation with an explicit realtime margin.
update public.provider_route_state
set expires_at = greatest(selected_at + interval '1 second', clock_timestamp()),
    version = version + 1,
    updated_at = clock_timestamp()
where expires_at > clock_timestamp();

comment on column public.provider_route_policies.realtime_throughput_margin is
  'Multiplier applied to exact average media throughput before a route can qualify.';

comment on column public.provider_route_measurements.minimum_required_bytes_per_second is
  'Per-file average byte rate including the configured realtime safety margin; zero is pre-V3 evidence.';

commit;
