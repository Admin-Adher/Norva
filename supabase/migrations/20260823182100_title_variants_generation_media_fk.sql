-- Install one NOT VALID composite FK under a short lock budget.  Validation is
-- performed later by the bounded service-only validation routine.
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
    where constraint_state.conrelid = 'public.cloud_title_variants'::regclass
      and constraint_state.conname = 'cloud_title_variants_generation_media_item_fk'
  ) then
    alter table public.cloud_title_variants
      add constraint cloud_title_variants_generation_media_item_fk
      foreign key (source_id, generation_id, media_item_id)
      references public.cloud_media_items(source_id, generation_id, id)
      on update cascade on delete cascade not valid;
  end if;
  perform public.norva_assert_catalog_generation_contract_constraint(
    'cloud_title_variants_generation_media_item_fk', false
  );
end
$install$;

commit;
