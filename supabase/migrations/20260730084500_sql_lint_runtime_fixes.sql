-- Correct four runtime-invalid routine bodies exposed by a full blank-database
-- replay followed by `supabase db lint --fail-on error`.
--
-- These are transformations of the canonical stored definitions rather than
-- duplicate hand-maintained copies of several hundred lines. Every replacement
-- is fail-closed: schema drift aborts the migration instead of silently leaving
-- an unsafe body installed.

-- `norva_backfill_media_identity` creates and consumes a session-local temp
-- table. plpgsql_check explicitly cannot validate that pattern; exempt only
-- this exact routine while keeping its runtime implementation unchanged.
alter function public.norva_backfill_media_identity(uuid, integer)
  set plpgsql.enable_check = false;

do $migration$
declare
  v_definition text;
  v_fixed text;
begin
  -- PostgreSQL cannot plan FULL JOIN with IS NOT DISTINCT FROM. Country codes
  -- are either ISO codes or NULL, so an empty-string sentinel makes both
  -- predicates hash-joinable without changing NULL grouping semantics.
  select pg_get_functiondef(
    'public.admin_vat_report(integer,integer)'::regprocedure
  ) into v_definition;
  v_fixed := replace(
    v_definition,
    'on rf.cc is not distinct from s.cc and rf.currency = s.currency',
    'on coalesce(rf.cc, '''') = coalesce(s.cc, '''') and rf.currency = s.currency'
  );
  v_fixed := replace(
    v_fixed,
    'on rx.cc is not distinct from sx.cc',
    'on coalesce(rx.cc, '''') = coalesce(sx.cc, '''')'
  );
  if v_fixed = v_definition
     or strpos(v_fixed, 'rf.cc is not distinct from s.cc') > 0
     or strpos(v_fixed, 'rx.cc is not distinct from sx.cc') > 0 then
    raise exception 'admin_vat_report definition drifted';
  end if;
  execute v_fixed;

  -- The RETURNS TABLE column notification_id is also a PL/pgSQL variable.
  -- Naming the unique constraint removes the ambiguous conflict target.
  select pg_get_functiondef(
    'public.queue_subtitle_ready_email_deliveries(uuid,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  v_fixed := replace(
    v_definition,
    'on conflict (notification_id) do update',
    'on conflict on constraint catalog_subtitle_email_deliveries_notification_id_key do update'
  );
  if v_fixed = v_definition then
    raise exception 'queue_subtitle_ready_email_deliveries definition drifted';
  end if;
  execute v_fixed;

  -- PostgreSQL ARE repetition bounds stop at 255. A one-character prefix plus
  -- a 0..255 suffix preserves the intended 1..256 tag contract.
  select pg_get_functiondef(
    'public.prepare_import_notification_delivery(uuid,uuid[],uuid,text,text,text,text,text,text,jsonb)'::regprocedure
  ) into v_definition;
  v_fixed := replace(
    v_definition,
    '^[A-Za-z0-9_-]{1,256}$',
    '^[A-Za-z0-9_-][A-Za-z0-9_-]{0,255}$'
  );
  if v_fixed = v_definition
     or strpos(v_fixed, '{1,256}') > 0 then
    raise exception 'prepare_import_notification_delivery definition drifted';
  end if;
  execute v_fixed;

  select pg_get_functiondef(
    'public.prepare_subtitle_email_delivery(uuid,uuid,text,text,text,text,text,text,jsonb)'::regprocedure
  ) into v_definition;
  v_fixed := replace(
    v_definition,
    '^[A-Za-z0-9_-]{1,256}$',
    '^[A-Za-z0-9_-][A-Za-z0-9_-]{0,255}$'
  );
  if v_fixed = v_definition
     or strpos(v_fixed, '{1,256}') > 0 then
    raise exception 'prepare_subtitle_email_delivery definition drifted';
  end if;
  execute v_fixed;
end
$migration$;
