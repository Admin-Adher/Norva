-- Partial VOD writes survive a distinct, fully verified operator rebuild.
\set phase3_expired_refresh_test 1
\set phase3_refresh_rebuild_test 1
\ir provider_credential_transition.sql
