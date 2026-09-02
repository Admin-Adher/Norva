begin;

-- Preserve the existing identity-free diagnostic model while distinguishing
-- the historical 1 MiB validation failure from generic/unknown errors.
alter table analytics_private.source_connection_attempts
  drop constraint if exists source_connection_attempts_failure_family_check;

alter table analytics_private.source_connection_attempts
  add constraint source_connection_attempts_failure_family_check check (
    failure_family is null
    or failure_family in (
      'credentials', 'missing_credentials', 'endpoint_not_found', 'timeout', 'provider_busy',
      'rate_limited', 'playlist_format', 'invalid_input', 'payload_too_large',
      'provider_unreachable', 'infrastructure', 'unknown'
    )
  );

comment on constraint source_connection_attempts_failure_family_check
  on analytics_private.source_connection_attempts is
  'Bounded operational families only; payload_too_large identifies an importer capacity response without retaining provider input.';

commit;
