begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
create or replace trigger trg_provider_access_feature_activation_guard
before insert or update on public.admin_feature_flags
for each row execute function public.norva_provider_access_feature_activation_guard();
insert into public.admin_feature_flags(key,enabled,description,updated_at,updated_by)
values
  ('provider_access_v1_enabled',false,'Provider Access snapshot and cycles; activation remains gated',now(),'migration:provider_access_lifecycle_foundation'),
  ('provider_access_auto_detection_v1_enabled',false,'Automatic provider access detection; fail-closed until a later phase',now(),'migration:provider_access_lifecycle_foundation'),
  ('provider_access_notifications_v1_enabled',false,'Provider Access notifications; must remain OFF until after the A-to-B E2E gate',now(),'migration:provider_access_lifecycle_foundation'),
  ('provider_access_visibility_v1_enabled',false,'Confirmed Provider Access states may hide an otherwise active source',now(),'migration:provider_access_lifecycle_foundation'),
  ('provider_credential_transition_v1_enabled',false,'Candidate credential transition workflow; no direct credential swap',now(),'migration:provider_access_lifecycle_foundation'),
  ('provider_replacement_v1_enabled',false,'Provider replacement staging and atomic promotion workflow',now(),'migration:provider_access_lifecycle_foundation')
on conflict (key) do update
set enabled = false, description = excluded.description,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by;
do $assert$
begin
  if (select count(*) <> 6 or coalesce(bool_or(enabled),false) from public.admin_feature_flags where key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
  ))
     or not public.norva_provider_access_foundation_trigger_is_exact('public.admin_feature_flags','trg_provider_access_feature_activation_guard','public.norva_provider_access_feature_activation_guard()'::regprocedure,23)
     or coalesce((select cardinality(tgattr::smallint[]) <> 0 from pg_catalog.pg_trigger where tgrelid='public.admin_feature_flags'::regclass and tgname='trg_provider_access_feature_activation_guard'),true) then
    raise exception 'provider access feature flags/activation guard drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
