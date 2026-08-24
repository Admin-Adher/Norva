begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A promotion proof is durable while its transition and candidate generation
-- exist, but it must never turn into retained account data.  The bounded
-- account-delete reaper removes generations before their transition row, so
-- this FK has to release the proof with that generation.
alter table public.cloud_source_replacement_promotion_v2_proofs
  drop constraint cloud_source_replacement_promotion_v2_proofs_generation_fk;

alter table public.cloud_source_replacement_promotion_v2_proofs
  add constraint cloud_source_replacement_promotion_v2_proofs_generation_fk
  foreign key (user_id, candidate_generation_id)
  references public.cloud_source_catalog_generations(user_id, id)
  on update cascade on delete cascade;

do $contract$
begin
  if not public.norva_catalog_expand_constraint_is_exact(
    'public.cloud_source_replacement_promotion_v2_proofs',
    'cloud_source_replacement_promotion_v2_proofs_generation_fk',
    'f', array['user_id','candidate_generation_id']::name[],
    'public.cloud_source_catalog_generations', array['user_id','id']::name[],
    null, 'c', 'c', 's', true
  ) then
    raise exception 'replacement promotion proof generation FK drift'
      using errcode = '55000';
  end if;
end
$contract$;

commit;
