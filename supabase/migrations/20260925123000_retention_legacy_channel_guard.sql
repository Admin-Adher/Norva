-- The old winback template links to the web checkout. Recheck the payment
-- channel at enqueue and at both delivery gates, including already queued mail.
begin;
create function public.norva_legacy_winback_allowed(p_user uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists (
    select 1 from public.cloud_entitlement_projection e
    where e.user_id=p_user and e.provider='revolut'
      and e.status in ('expired','canceled','cancelled')
      and e.winback_email_at is null
      and (select enabled from public.cloud_retention_policy where singleton) is false
  );
$$;
revoke all on function public.norva_legacy_winback_allowed(uuid) from public,anon,authenticated;
grant execute on function public.norva_legacy_winback_allowed(uuid) to service_role;

do $patch$
declare f record; definition text; revised text; enqueues integer:=0; deliveries integer:=0;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='norva_enqueue_lifecycle_email'
  loop
    definition:=pg_get_functiondef(f.oid);
    revised:=replace(definition,
      'v_marker = ''winback'' and (v_flow <> ''winback'' or not p_marketing)',
      'v_marker = ''winback'' and (v_flow <> ''winback'' or not p_marketing or not public.norva_legacy_winback_allowed(p_user_id))');
    if revised=definition then raise exception 'legacy winback enqueue contract missing'; end if;
    execute revised; enqueues:=enqueues+1;
  end loop;
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','norva_postal_full') and p.prorettype='boolean'::regtype
      and (p.proname like 'authorize_branded_email_delivery%' or p.proname='branded_allowed')
      and p.prosrc like '%elsif o.marker_kind = ''winback'' then%'
  loop
    definition:=pg_get_functiondef(f.oid);
    revised:=replace(definition,'elsif o.marker_kind = ''winback'' then',
      'elsif o.marker_kind = ''winback'' then
         if not public.norva_legacy_winback_allowed(o.user_id) then return false; end if;');
    execute revised; deliveries:=deliveries+1;
  end loop;
  if enqueues<>1 or deliveries<>2 then
    raise exception 'legacy winback gate inventory changed: %, %',enqueues,deliveries;
  end if;
end;
$patch$;
commit;
