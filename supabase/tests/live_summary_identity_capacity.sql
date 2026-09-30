-- Run inside a transaction after the live-summary capacity migration.
-- Read-only production regression: no fixture rows or catalogue mutations.
do $test$
declare r record; n bigint; bad text[];
begin
  select source_id,user_id,generation_id,logical_id into strict r
  from public.cloud_live_logical_channels limit 1;
  select count(*) into n from public.norva_get_generation_live_channel_summaries(r.source_id,r.user_id,r.generation_id,array[r.logical_id]);
  if n <> 1 then raise exception 'same-owner lookup failed'; end if;
  select count(*) into n from public.norva_get_generation_live_channel_summaries(r.source_id,gen_random_uuid(),r.generation_id,array[r.logical_id]);
  if n <> 0 then raise exception 'cross-owner leakage'; end if;
  select count(*) into n from public.norva_get_generation_live_channel_summaries(r.source_id,r.user_id,gen_random_uuid(),array[r.logical_id]);
  if n <> 0 then raise exception 'cross-generation leakage'; end if;
  perform * from public.norva_get_generation_live_channel_summaries(r.source_id,r.user_id,r.generation_id,array['lc_'||repeat('a',511)]);
  perform * from public.norva_get_generation_live_channel_summaries(r.source_id,r.user_id,r.generation_id,array[repeat('a',2048)]);
  foreach bad slice 1 in array array[array[repeat('a',2049)],array[''],array[E'bad\nkey'],array[repeat('é',1025)]] loop
    begin
      perform * from public.norva_get_generation_live_channel_summaries(r.source_id,r.user_id,r.generation_id,bad);
      raise exception 'invalid identity accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform * from public.norva_get_generation_live_channel_summaries(r.source_id,r.user_id,r.generation_id,array_fill('a'::text,array[501]));
    raise exception 'oversized batch accepted';
  exception when invalid_parameter_value then null;
  end;
  if has_function_privilege('authenticated','public.norva_get_generation_live_channel_summaries(uuid,uuid,uuid,text[])','execute') then raise exception 'public RPC access'; end if;
end
$test$;