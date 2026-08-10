-- PostgreSQL stores identifiers in at most 63 bytes. The previous public RPC
-- name was 66 bytes long, so PostgreSQL silently stored a truncated name while
-- the Edge Function asked PostgREST for the untruncated route. Rename the
-- existing wrapper to a stable, explicit Data API name that is safely below
-- the identifier limit. The private implementation and all reducer semantics
-- remain unchanged.

alter function
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  )
rename to partners_service_kyc_certification_webhook_apply_purge;

revoke all on function
  public.partners_service_kyc_certification_webhook_apply_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  public.partners_service_kyc_certification_webhook_apply_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  )
to service_role;

comment on function
  public.partners_service_kyc_certification_webhook_apply_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ) is
  'Service-only PostgREST wrapper for atomic Didit certification reduction and encrypted purge enqueue; the bounded name is intentionally below PostgreSQL max_identifier_length.';

do $partners_didit_certification_rpc_alias_contract$
declare
  v_rpc_name constant text :=
    'partners_service_kyc_certification_webhook_apply_purge';
begin
  if octet_length(v_rpc_name) > current_setting('max_identifier_length')::integer then
    raise exception 'Didit certification RPC exceeds max_identifier_length';
  end if;

  if to_regprocedure(
    'public.partners_service_kyc_certification_webhook_apply_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'
  ) is null then
    raise exception 'Didit certification RPC alias is unavailable';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = v_rpc_name
      and procedure_row.prosecdef
  ) then
    raise exception 'Didit certification RPC alias must remain SECURITY INVOKER';
  end if;
end;
$partners_didit_certification_rpc_alias_contract$;
