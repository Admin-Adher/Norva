begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $install$
begin
  if not public.norva_catalog_generation_flags_all_off()
     or not public.norva_catalog_generation_indexes_online_ready()
     or exists (
       select 1 from public.cloud_catalog_generation_rollout rollout
       where rollout.singleton and rollout.contracted_at is not null
     ) then
    raise exception 'catalog generation composite FK expand gate failed'
      using errcode = '55000';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid = 'public.catalog_series_inventory_state'::regclass
      and constraint_state.conname = 'catalog_series_inventory_gen_parent_natural_fk'
  ) then
    alter table public.catalog_series_inventory_state
      add constraint catalog_series_inventory_gen_parent_natural_fk
      foreign key (source_id, generation_id, parent_item_type, parent_series_id)
      references public.cloud_title_variants(
        source_id, generation_id, item_type, external_id
      ) on update cascade on delete cascade not valid;
  end if;
  perform public.norva_assert_catalog_generation_contract_constraint(
    'catalog_series_inventory_gen_parent_natural_fk', false
  );
end
$install$;

commit;
