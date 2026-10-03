-- Limit expensive eligibility checks per transaction. Empty pages advance the
-- existing durable cursor; no file is skipped and no provider gate changes.
begin;
set local lock_timeout='3s';
set local statement_timeout='15s';
do $patch$
declare d text; old_page text := 'order by v.id limit 256) page;';
begin
 d:=pg_get_functiondef('public.claim_catalog_provider_audio_metadata(uuid,uuid)'::regprocedure);
 if (length(d)-length(replace(d,old_page,'')))/length(old_page) <> 1 then
  raise exception 'Provider metadata pagination drift';
 end if;
 execute replace(d,old_page,'order by v.id limit 32) page;');
end $patch$;
commit;
