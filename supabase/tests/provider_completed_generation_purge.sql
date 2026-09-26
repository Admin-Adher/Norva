-- Complete the ordinary renewal protocol, then clean its superseded generation.
\set phase3_expired_refresh_test 1
\set phase3_renewal_access_test 1
\set phase3_terminal_purge_test 1
\ir provider_credential_transition.sql
