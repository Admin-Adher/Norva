begin;

-- Supabase installations may grant broad table privileges to service_role via
-- ALTER DEFAULT PRIVILEGES. Revoke them explicitly so readiness evidence can
-- only be appended and read, never rewritten, deleted or truncated.
revoke all on table public.behavioral_lifecycle_import_readiness
from service_role;

grant select, insert on table public.behavioral_lifecycle_import_readiness
to service_role;

commit;
