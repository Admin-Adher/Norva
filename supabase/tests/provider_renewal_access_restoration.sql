-- Complete the real credential protocol before checking access scheduling.
\set phase3_expired_refresh_test 1
\set phase3_renewal_access_test 1
\ir provider_credential_transition.sql
