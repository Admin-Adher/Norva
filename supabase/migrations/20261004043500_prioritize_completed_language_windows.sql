begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- A track with all signed window receipts needs consensus, not another capture.
-- Let that existing worker branch run ahead of incomplete captures, just as the
-- completed SQL finalizer already does. This is ordering only: due times, manual
-- requests, active leases, capacity and source-scoped exclusion remain intact.
do $patch$
declare d text; old text; replacement text;
begin
 d:=pg_get_functiondef('public.list_due_catalog_file_audio_validation_jobs(integer)'::regprocedure);
 old:=$old$case when j.state='finalizing'
        and j.next_track_position=cardinality(j.expected_audio_indices)
        and jsonb_array_length(j.evidence)=cardinality(j.expected_audio_indices)
        then 0 else 1 end$old$;
 replacement:=$new$case when (j.state='finalizing'
        and j.next_track_position=cardinality(j.expected_audio_indices)
        and jsonb_array_length(j.evidence)=cardinality(j.expected_audio_indices))
        or (j.next_track_position<cardinality(j.expected_audio_indices)
          and jsonb_array_length(j.evidence)=j.next_track_position
          and j.strict_lid_window_protocol=1 and j.strict_lid_window_count in (4,6)
          and j.strict_lid_window_position=j.strict_lid_window_count
          and jsonb_array_length(j.strict_lid_window_tokens)=j.strict_lid_window_count)
        then 0 else 1 end$new$;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Finalizer projection drifted'; end if;
 d:=replace(d,old,replacement);
 -- The lane expression has two additional indentation spaces.
 old:=replace(old,E'\n',E'\n  ');
 replacement:=replace(replacement,E'\n',E'\n  ');
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Finalizer lane ordering drifted'; end if;
 d:=replace(d,old,replacement);
 execute d;
end $patch$;
notify pgrst,'reload schema';
commit;
