-- An unrelated catalogue/Selection refresh advances the owner's global cache
-- epoch. That is not a change to the exact file previously heard by the owner.
-- Revalidate current visibility plus every file/source/profile fence at read
-- time. Preserve the original testimony and the full write-time epoch CAS.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $migration$
declare body text;
  old_join text := '  left join public.cloud_user_catalog_visibility_epochs e on e.user_id=c.user_id';
  old_where text := '  where coalesce(e.visibility_epoch,1)=c.user_visibility_epoch
    and public.norva_source_catalog_visible_internal(c.source_id,c.user_id)';
begin
  body:=pg_get_functiondef('public.cloud_catalog_owned_movie_human_audio_confirmations_batch(uuid,uuid,uuid[])'::regprocedure);
  body:=replace(body,chr(13),'');
  old_where:=replace(old_where,chr(13),'');
  if md5(body)<>'a4cf4d94b3e8e3b4e9c6ea2cc781e0c0' then
    raise exception 'Owner audio projection drifted; refusing migration' using errcode='55000';
  end if;
  if (length(body)-length(replace(body,old_join,'')))/length(old_join)<>1
    or (length(body)-length(replace(body,old_where,'')))/length(old_where)<>1 then
    raise exception 'Owner audio visibility guard drifted; refusing migration' using errcode='55000';
  end if;
  body:=replace(body,old_join||chr(10),'');
  body:=replace(body,old_where,'  where public.norva_source_catalog_visible_internal(c.source_id,c.user_id)');
  execute body;
end $migration$;
-- RPC signature, owner, ACLs, owner/source/track/profile predicates, active
-- generation and current visibility are unchanged. No evidence is rewritten.
notify pgrst,'reload schema';
commit;
