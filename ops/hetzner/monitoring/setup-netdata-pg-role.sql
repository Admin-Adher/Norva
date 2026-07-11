-- =============================================================================
-- Read-only monitoring role for Netdata's go.d PostgreSQL collector.
-- =============================================================================
-- Run ONCE on the box, as superuser, passing the password as a psql variable:
--
--   NETDATA_PG_PASSWORD=$(openssl rand -hex 24)
--   echo "NETDATA_PG_PASSWORD=$NETDATA_PG_PASSWORD" >> .env      # ops/hetzner/.env
--   dpsql -v pw="$NETDATA_PG_PASSWORD" -f - < monitoring/setup-netdata-pg-role.sql
--
-- `pg_monitor` bundles pg_read_all_settings + pg_read_all_stats +
-- pg_stat_scan_tables — exactly what the collector needs. The role has NO
-- superuser, NO write access, and reads no application rows.
-- Idempotent: safe to re-run (e.g. to rotate the password).
-- =============================================================================

-- Create the login role only if it does not already exist (\gexec runs the
-- generated CREATE; on re-runs the WHERE yields no row, so nothing happens).
SELECT 'CREATE ROLE netdata LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netdata')
\gexec

-- Always (re)assert the exact attributes + password (rotation path).
ALTER ROLE netdata WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
                        NOREPLICATION INHERIT PASSWORD :'pw';

GRANT pg_monitor TO netdata;
GRANT CONNECT ON DATABASE postgres TO netdata;

-- Sanity: must be a plain login role, not superuser.
SELECT rolname, rolsuper, rolcanlogin, rolreplication
FROM pg_roles WHERE rolname = 'netdata';
