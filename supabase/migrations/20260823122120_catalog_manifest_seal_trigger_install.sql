begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create or replace trigger trg_credential_transition_manifest_seal_release
after update of state on public.cloud_source_transitions
for each row execute function
  public.norva_release_catalog_manifest_seal_on_terminal();

create or replace trigger trg_candidate_titles_manifest_seal_guard
before insert or update or delete
on public.cloud_source_catalog_generation_candidate_titles
for each row execute function public.norva_candidate_title_manifest_seal_guard();

-- The row guard rejects writers that start after the fence.  These statement
-- triggers close the complementary race: a writer that passed BEFORE ROW,
-- paused, and attempts to commit after sealing must CAS the generation row and
-- roll its entire statement back.
create or replace trigger trg_candidate_titles_generation_revision_i
after insert on public.cloud_source_catalog_generation_candidate_titles
referencing new table as new_rows
for each statement execute function public.norva_catalog_generation_row_changed();

create or replace trigger trg_candidate_titles_generation_revision_u
after update on public.cloud_source_catalog_generation_candidate_titles
referencing new table as new_rows
for each statement execute function public.norva_catalog_generation_row_changed();

create or replace trigger trg_candidate_titles_generation_revision_d
after delete on public.cloud_source_catalog_generation_candidate_titles
referencing old table as old_rows
for each statement execute function public.norva_catalog_generation_row_changed();

do $postcondition$
declare
  v_state_attnum smallint;
  v_transition_tgattr smallint[];
  v_projection_tgattr smallint[];
begin
  if not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_source_transitions',
       'trg_credential_transition_manifest_seal_release',
       'public.norva_release_catalog_manifest_seal_on_terminal()'::regprocedure,
       17
     )
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_source_catalog_generation_candidate_titles',
       'trg_candidate_titles_manifest_seal_guard',
       'public.norva_candidate_title_manifest_seal_guard()'::regprocedure,
       31
     )
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_source_catalog_generation_candidate_titles',
       'trg_candidate_titles_generation_revision_i',
       'public.norva_catalog_generation_row_changed()'::regprocedure,
       4
     )
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_source_catalog_generation_candidate_titles',
       'trg_candidate_titles_generation_revision_u',
       'public.norva_catalog_generation_row_changed()'::regprocedure,
       16
     )
     or not public.norva_catalog_expand_trigger_is_exact(
       'public.cloud_source_catalog_generation_candidate_titles',
       'trg_candidate_titles_generation_revision_d',
       'public.norva_catalog_generation_row_changed()'::regprocedure,
       8
     ) then
    raise exception 'catalog manifest seal trigger drift'
      using errcode = '55000';
  end if;
  select attribute_state.attnum into strict v_state_attnum
  from pg_attribute attribute_state
  where attribute_state.attrelid = 'public.cloud_source_transitions'::regclass
    and attribute_state.attname = 'state' and not attribute_state.attisdropped;
  select trigger_state.tgattr::smallint[] into strict v_transition_tgattr
  from pg_trigger trigger_state
  where trigger_state.tgrelid = 'public.cloud_source_transitions'::regclass
    and trigger_state.tgname =
      'trg_credential_transition_manifest_seal_release';
  select trigger_state.tgattr::smallint[] into strict v_projection_tgattr
  from pg_trigger trigger_state
  where trigger_state.tgrelid =
      'public.cloud_source_catalog_generation_candidate_titles'::regclass
    and trigger_state.tgname = 'trg_candidate_titles_manifest_seal_guard';
  if array_to_string(v_transition_tgattr,',') is distinct from
       v_state_attnum::text
     or coalesce(cardinality(v_projection_tgattr),0) <> 0 then
    raise exception 'catalog manifest seal trigger column drift'
      using errcode = '55000';
  end if;
  if (
    select count(*)
    from pg_trigger trigger_state
    where trigger_state.tgrelid =
        'public.cloud_source_catalog_generation_candidate_titles'::regclass
      and not trigger_state.tgisinternal
      and (
        (trigger_state.tgname = 'trg_candidate_titles_generation_revision_i'
          and trigger_state.tgnewtable = 'new_rows'
          and trigger_state.tgoldtable is null)
        or
        (trigger_state.tgname = 'trg_candidate_titles_generation_revision_u'
          and trigger_state.tgnewtable = 'new_rows'
          and trigger_state.tgoldtable is null)
        or
        (trigger_state.tgname = 'trg_candidate_titles_generation_revision_d'
          and trigger_state.tgoldtable = 'old_rows'
          and trigger_state.tgnewtable is null)
      )
  ) <> 3 then
    raise exception 'candidate title transition-table trigger drift'
      using errcode = '55000';
  end if;
end
$postcondition$;

commit;
