-- Supabase self-host JWT settings (official docker/volumes/db/jwt.sql).
-- Stores the JWT secret + expiry as DB settings so PostgREST/GoTrue and the app's
-- existing anon/service keys (which we REUSE from the managed project) validate.
-- Mounted into /docker-entrypoint-initdb.d/init-scripts/ ; runs once on fresh init.
-- JWT_SECRET + JWT_EXP come from the db container environment.
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
