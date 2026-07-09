-- Supabase self-host role passwords (official docker/volumes/db/roles.sql).
-- The supabase/postgres image's bundled migrations CREATE these roles; this script
-- only sets their password to POSTGRES_PASSWORD so the stack services (auth/rest/
-- storage/functions) — which all connect with POSTGRES_PASSWORD — can authenticate.
-- Mounted into /docker-entrypoint-initdb.d/init-scripts/ ; runs once on fresh init.
-- POSTGRES_PASSWORD comes from the db container environment.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_functions_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
