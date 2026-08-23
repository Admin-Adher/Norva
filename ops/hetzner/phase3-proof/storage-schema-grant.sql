-- Permit the isolated migration runner to own only its synthetic Storage
-- tables. The existing `storage` schema remains owned by supabase_admin.
grant usage, create on schema storage to postgres;
