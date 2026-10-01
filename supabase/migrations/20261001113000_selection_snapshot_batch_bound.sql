-- The immutable manifest remains bounded by 256 KiB and all existing exact
-- file/owner/generation checks. Fewer batches avoid repeated authority scans.
begin;
set local lock_timeout='3s';
do $migration$
declare body text;
begin
  body:=pg_get_functiondef('public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)'::regprocedure);
  if position('jsonb_array_length(p_files)>50' in body)=0 then
    raise exception 'Unexpected Selection hydration definition';
  end if;
  execute replace(body,'jsonb_array_length(p_files)>50','jsonb_array_length(p_files)>250');
end
$migration$;
notify pgrst,'reload schema';
commit;
