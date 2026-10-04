begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- An interrupted worker can leave all track evidence complete until its lease
-- expires. Finalization is database-only, but used to wait behind repeated
-- capture checkpoints. Within each request priority, finish these receipts first.
-- This changes ordering only: source-scoped admission, quarantine, active leases,
-- capacity, exact-profile validation and strict evidence checks remain enforced.
do $patch$
declare d text; old text;
begin
 d:=pg_get_functiondef('public.list_due_catalog_file_audio_validation_jobs(integer)'::regprocedure);
 old:=$old$coalesce(j.retry_at,j.lease_expires_at,j.created_at) as due_at,$old$;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Due-file projection drifted'; end if;
 d:=replace(d,old,$new$coalesce(j.retry_at,j.lease_expires_at,j.created_at) as due_at,
      case when j.state='finalizing'
        and j.next_track_position=cardinality(j.expected_audio_indices)
        and jsonb_array_length(j.evidence)=cardinality(j.expected_audio_indices)
        then 0 else 1 end as finalization_priority,$new$);
 old:=$old$case when j.request_origin='manual' then 0 else 1 end,
        coalesce(j.retry_at,j.lease_expires_at,j.created_at),j.id)$old$;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Due-file lane ordering drifted'; end if;
 d:=replace(d,old,$new$case when j.request_origin='manual' then 0 else 1 end,
        case when j.state='finalizing'
          and j.next_track_position=cardinality(j.expected_audio_indices)
          and jsonb_array_length(j.evidence)=cardinality(j.expected_audio_indices)
          then 0 else 1 end,
        coalesce(j.retry_at,j.lease_expires_at,j.created_at),j.id)$new$);
 old:=$old$order by priority,due_at,id$old$;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Due-file global ordering drifted'; end if;
 d:=replace(d,old,$new$order by priority,finalization_priority,due_at,id$new$);
 execute d;
end $patch$;
notify pgrst,'reload schema';
commit;
