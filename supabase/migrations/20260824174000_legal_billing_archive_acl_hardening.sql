-- Production restores revealed historical Supabase default grants on the v1
-- archive tables even though the original migration revoked them. Reassert the
-- complete direct-table boundary after every v2 object exists and fail the
-- migration if any API role still has a data privilege.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

alter table public.legal_billing_archive_retention_policy enable row level security;
alter table public.legal_billing_archive enable row level security;
alter table public.legal_billing_archive_policy_events enable row level security;
alter table public.legal_billing_archive_access_grants enable row level security;
alter table public.legal_billing_archive_access_grant_events enable row level security;
alter table public.legal_billing_archive_access_events enable row level security;

revoke all on table
  public.legal_billing_archive_retention_policy,
  public.legal_billing_archive,
  public.legal_billing_archive_policy_events,
  public.legal_billing_archive_access_grants,
  public.legal_billing_archive_access_grant_events,
  public.legal_billing_archive_access_events
from public, anon, authenticated, service_role;

revoke all on sequence public.legal_billing_archive_policy_events_event_id_seq,
  public.legal_billing_archive_access_grant_events_event_id_seq
from public, anon, authenticated, service_role;

do $acl_proof$
declare
  v_role text;
  v_table text;
  v_privilege text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    foreach v_table in array array[
      'legal_billing_archive_retention_policy',
      'legal_billing_archive',
      'legal_billing_archive_policy_events',
      'legal_billing_archive_access_grants',
      'legal_billing_archive_access_grant_events',
      'legal_billing_archive_access_events'
    ] loop
      foreach v_privilege in array array[
        'select','insert','update','delete','truncate','references','trigger'
      ] loop
        if pg_catalog.has_table_privilege(
          v_role,
          format('public.%I',v_table),
          v_privilege
        ) then
          raise exception 'legal billing archive direct table privilege remains'
            using errcode='42501',
              detail=format('role=%s;table=%s;privilege=%s',v_role,v_table,v_privilege);
        end if;
      end loop;
    end loop;
  end loop;
end
$acl_proof$;

comment on table public.legal_billing_archive is
  'Minimal legal billing archive. No API role has direct table access; deletion workflow and audited Admin+AAL2 reader RPCs are the only paths.';

commit;
