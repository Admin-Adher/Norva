begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_provider_access_flag_visibility_epoch
after update of enabled on public.admin_feature_flags
for each row execute function public.norva_provider_access_flag_visibility_changed();
do $assert$
declare
  v_enabled_attnum smallint;
  v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.admin_feature_flags','trg_provider_access_feature_activation_guard','public.norva_provider_access_feature_activation_guard()'::regprocedure,23)
     or not public.norva_provider_access_foundation_trigger_is_exact('public.admin_feature_flags','trg_provider_access_flag_visibility_epoch','public.norva_provider_access_flag_visibility_changed()'::regprocedure,17) then
    raise exception 'provider access flag trigger drift' using errcode='55000';
  end if;
  select attnum into strict v_enabled_attnum from pg_catalog.pg_attribute where attrelid='public.admin_feature_flags'::regclass and attname='enabled' and not attisdropped;
  select tgattr::smallint[] into strict v_actual from pg_catalog.pg_trigger where tgrelid='public.admin_feature_flags'::regclass and tgname='trg_provider_access_flag_visibility_epoch';
  if pg_catalog.array_to_string(v_actual, ',') is distinct from v_enabled_attnum::text then
    raise exception 'provider access flag trigger column drift' using errcode='55000';
  end if;
end
$assert$;
commit;
