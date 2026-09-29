begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Dispatch must use the same source rollout as exact-file admission. This only
-- selects candidates: account/file leases and playback priority still decide
-- whether a worker may perform provider I/O. Mixed legacy/scoped active lanes
-- remain serialized by identity until both sources support exact admission.
do $patch$
declare d text; old text;
begin
 d:=pg_get_functiondef('public.list_due_catalog_file_audio_validation_jobs(integer)'::regprocedure);
 old:='case when public.catalog_language_exact_file_admission_enabled() then j.source_id else null end';
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then
  raise exception 'Due-file source partition drifted';
 end if;
 d:=replace(d,old,'case when (public.catalog_language_exact_file_admission_enabled() or public.catalog_language_exact_file_enabled_for_source(j.requested_by,j.source_id)) then j.source_id else null end');
 old:='(not public.catalog_language_exact_file_admission_enabled() or active.source_id=j.source_id)';
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then
  raise exception 'Due-file active source guard drifted';
 end if;
 d:=replace(d,old,'((not public.catalog_language_exact_file_admission_enabled() and (not public.catalog_language_exact_file_enabled_for_source(j.requested_by,j.source_id) or not public.catalog_language_exact_file_enabled_for_source(active.requested_by,active.source_id))) or active.source_id=j.source_id)');
 execute d;
end $patch$;
notify pgrst,'reload schema';
commit;
