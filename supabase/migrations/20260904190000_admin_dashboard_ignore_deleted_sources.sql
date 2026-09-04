-- Keep soft-deleted provider sources out of actionable admin health signals.
--
-- A removed source can retain catalogue rows for bounded recovery/audit purposes.
-- Those rows must not make the source look like an active VOD import with no
-- variants.  Rebuild the two existing dashboard functions from their current
-- definitions so later metrics added to them remain byte-for-byte intact.
-- Every replacement is guarded and the migration fails closed if an upstream
-- definition no longer matches the expected contract.

do $migration$
declare
  v_definition text;
  v_needle text;
  v_replacement text;
begin
  select pg_get_functiondef('public.refresh_admin_dashboard()'::regprocedure)
    into v_definition;

  if v_definition is null then
    raise exception 'refresh_admin_dashboard() is missing';
  end if;

  v_needle := $needle$           (coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete,$needle$;
  v_replacement := $replacement$           (s.deleted_at is null and coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete,$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected refresh_admin_dashboard incomplete projection';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$    where s.user_id in (select user_id from public.admin_enrichment_accounts)
       or s.sync_status = 'sync_error' or s.sync_error is not null
       or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
           and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))$needle$;
  v_replacement := $replacement$    where s.deleted_at is null
      and (
        s.user_id in (select user_id from public.admin_enrichment_accounts)
        or s.sync_status = 'sync_error' or s.sync_error is not null
        or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
            and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))
      )$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected refresh_admin_dashboard source row predicate';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$      'sources_total',(select count(*) from cloud_sources),$needle$;
  v_replacement := $replacement$      'sources_total',(select count(*) from cloud_sources where deleted_at is null),$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected refresh_admin_dashboard sources_total metric';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$      'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),$needle$;
  v_replacement := $replacement$      'sources_error',(select count(*) from cloud_sources where deleted_at is null and (sync_status = 'sync_error' or sync_error is not null)),$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected refresh_admin_dashboard sources_error metric';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$          where coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),$needle$;
  v_replacement := $replacement$          where s.deleted_at is null and coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected refresh_admin_dashboard sources_incomplete metric';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  execute v_definition;

  select pg_get_functiondef('public.snapshot_admin_metrics()'::regprocedure)
    into v_definition;

  if v_definition is null then
    raise exception 'snapshot_admin_metrics() is missing';
  end if;

  v_needle := $needle$    (t,'sources_total',      (select count(*) from cloud_sources)),$needle$;
  v_replacement := $replacement$    (t,'sources_total',      (select count(*) from cloud_sources where deleted_at is null)),$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected snapshot_admin_metrics sources_total metric';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$                                where coalesce(mc.n,0)>0 and coalesce(vc.n,0)=0)),$needle$;
  v_replacement := $replacement$                                where s.deleted_at is null and coalesce(mc.n,0)>0 and coalesce(vc.n,0)=0)),$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected snapshot_admin_metrics sources_incomplete metric';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$    (t,'sources_error',      (select count(*) from cloud_sources where sync_status='sync_error' or sync_error is not null)),$needle$;
  v_replacement := $replacement$    (t,'sources_error',      (select count(*) from cloud_sources where deleted_at is null and (sync_status='sync_error' or sync_error is not null))),$replacement$;
  if length(v_definition) - length(replace(v_definition, v_needle, '')) <> length(v_needle) then
    raise exception 'unexpected snapshot_admin_metrics sources_error metric';
  end if;
  v_definition := replace(v_definition, v_needle, v_replacement);

  execute v_definition;
end;
$migration$;
