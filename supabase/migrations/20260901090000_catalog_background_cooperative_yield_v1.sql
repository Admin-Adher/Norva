begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- A completed Edge slice must not retain the crash-recovery lease for the
-- remainder of its 180-second TTL.  This CAS expires only the exact live lease
-- after every selected item has been durably acknowledged.  The checkpoint,
-- owner snapshot and cursor stay untouched, so the next worker resumes rather
-- than restarting the cycle.  A crash or a partial inflight page cannot yield.
create or replace function public.norva_yield_catalog_title_background_mode(
  p_mode text,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_checkpoint public.cloud_catalog_background_mode_checkpoints%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 160
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 1
     or p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'invalid catalog background cooperative yield arguments'
      using errcode = '22023';
  end if;

  select checkpoint.* into v_checkpoint
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.mode = p_mode
  for update;

  if not found
     or v_checkpoint.state <> 'processing'
     or v_checkpoint.lease_owner <> p_worker
     or v_checkpoint.lease_sequence <> p_expected_lease_sequence
     or v_checkpoint.lease_until <= now()
     or v_checkpoint.revision <> p_expected_revision then
    raise exception 'catalog background cooperative yield CAS failed'
      using errcode = 'PT409';
  end if;
  if jsonb_array_length(v_checkpoint.inflight_items) <> 0 then
    raise exception 'catalog background cooperative yield has inflight work'
      using errcode = 'PT409',
        detail = 'reason=catalog_background_inflight_not_empty';
  end if;

  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set lease_until = clock_timestamp(),
      revision = checkpoint.revision + 1,
      updated_at = clock_timestamp()
  where checkpoint.mode = p_mode
    and checkpoint.state = 'processing'
    and checkpoint.lease_owner = p_worker
    and checkpoint.lease_sequence = p_expected_lease_sequence
    and checkpoint.revision = p_expected_revision
    and checkpoint.lease_until > now()
    and jsonb_array_length(checkpoint.inflight_items) = 0
  returning checkpoint.* into v_checkpoint;
  if not found then
    raise exception 'catalog background cooperative yield update CAS failed'
      using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'contract','catalog-title-background-mode-v1',
    'mode',p_mode,
    'worker',p_worker,
    'leaseSequence',v_checkpoint.lease_sequence,
    'checkpointRevision',v_checkpoint.revision,
    'leaseUntil',v_checkpoint.lease_until,
    'yielded',true
  );
end
$function$;

revoke all on function public.norva_yield_catalog_title_background_mode(
  text,text,integer,bigint
) from public, anon, authenticated, service_role;
grant execute on function public.norva_yield_catalog_title_background_mode(
  text,text,integer,bigint
) to service_role;

comment on function public.norva_yield_catalog_title_background_mode(
  text,text,integer,bigint
) is
  'CAS-expires an empty successful catalogue-background lease while preserving its durable cursor.';

do $assert$
begin
  if not has_function_privilege(
       'service_role',
       'public.norva_yield_catalog_title_background_mode(text,text,integer,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_yield_catalog_title_background_mode(text,text,integer,bigint)',
       'EXECUTE'
     ) then
    raise exception 'catalog background cooperative yield ACL drift';
  end if;
end
$assert$;

commit;
