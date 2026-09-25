-- Full production credential protocol with an expired source, including
-- leased refresh writes, terminal completion and immutable dead-job recovery.
\set phase3_expired_refresh_test 1
\ir provider_credential_transition.sql
