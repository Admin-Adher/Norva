begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
lock table public.admin_feature_flags in share row exclusive mode;
create or replace function public.norva_catalog_generation_flag_contract_guard()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.key in (
       'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
       'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
       'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
     ) and new.enabled and (tg_op='INSERT' or not coalesce(old.enabled,false))
     and not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('catalog-generation-index-repair-v1',0)) then
    raise exception 'catalog generation index repair blocks flag activation' using errcode='55P03';
  end if;
  if new.key in ('provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')
     and new.enabled and (tg_op='INSERT' or not coalesce(old.enabled,false))
     and not exists (
       select 1 from public.cloud_catalog_generation_rollout rollout
       where rollout.singleton and rollout.phase='contracted' and rollout.contracted_at is not null
     ) then
    raise exception 'catalog generation rollout must be contracted before activation' using errcode='55000';
  end if;
  if new.key in ('provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')
     and new.enabled and (tg_op='INSERT' or not coalesce(old.enabled,false))
     and not public.norva_title_gc_indexes_ready() then
    raise exception 'candidate title GC indexes must be exact before activation'
      using errcode='55000', detail='reason=title_gc_index_drift';
  end if;
  if new.key in ('provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')
     and new.enabled and (tg_op='INSERT' or not coalesce(old.enabled,false))
     and not public.norva_catalog_title_projection_indexes_ready() then
    raise exception 'catalog title projection indexes must be exact before activation'
      using errcode='55000', detail='reason=title_projection_index_drift';
  end if;
  if new.key in ('provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')
     and new.enabled and (tg_op='INSERT' or not coalesce(old.enabled,false))
     and not public.norva_catalog_title_active_payload_indexes_ready() then
    raise exception 'active title payload index must be exact before activation'
      using errcode='55000', detail='reason=title_projection_index_drift';
  end if;
  return new;
end
$function$;
create or replace trigger trg_catalog_generation_flag_contract_guard
before insert or update of enabled on public.admin_feature_flags
for each row execute function public.norva_catalog_generation_flag_contract_guard();
update public.admin_feature_flags set enabled=false,updated_at=clock_timestamp(),updated_by='migration:catalog_generation_flag_gate'
where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled');
do $postcondition$
declare v_enabled smallint; v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.admin_feature_flags','trg_catalog_generation_flag_contract_guard','public.norva_catalog_generation_flag_contract_guard()'::regprocedure,23)
     or (select count(*)<>6 or coalesce(bool_or(enabled),false) from public.admin_feature_flags where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')) then
    raise exception 'catalog generation flag gate drift' using errcode='55000';
  end if;
  select attnum into strict v_enabled from pg_catalog.pg_attribute where attrelid='public.admin_feature_flags'::regclass and attname='enabled' and not attisdropped;
  select tgattr::smallint[] into strict v_actual from pg_catalog.pg_trigger where tgrelid='public.admin_feature_flags'::regclass and tgname='trg_catalog_generation_flag_contract_guard';
  if pg_catalog.array_to_string(v_actual,',') is distinct from v_enabled::text then raise exception 'catalog generation flag gate column drift' using errcode='55000'; end if;
end
$postcondition$;
commit;
