-- Exact initial-checkpoint recovery, rejected accepted-manifest recovery,
-- idempotent retry, and full healthy completion through the ordinary writers.
\set phase3_expired_refresh_test 1
\set phase3_empty_refresh_test 1
\ir provider_credential_transition.sql
