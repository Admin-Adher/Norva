-- Append to the migration in a caller-owned transaction; always ROLLBACK.
-- Fixture identities and ciphertexts are synthetic. No provider I/O occurs.
set local request.jwt.claim.role='service_role';
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
 raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('96000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
 'authenticated','authenticated','transport-fixture@invalid.test','',now(),'{}','{}',now(),now());
insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,
 sync_status,catalog_version,enabled,last_synced_at)
values('96000000-0000-4000-8000-000000000101','96000000-0000-4000-8000-000000000001',
 'xtream','Transport rollback fixture','transport-test-A','{}','ready',1,true,now());
insert into public.cloud_source_provider_account_affinities(source_id,user_id,affinity_hash)
values('96000000-0000-4000-8000-000000000101','96000000-0000-4000-8000-000000000001',repeat('a',64));
insert into public.cloud_media_items(user_id,source_id,generation_id,item_type,external_id,title,parent_external_id,
 write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
select h.user_id,h.source_id,h.active_generation_id,'movie',n::text,'Fixture '||n,'1',
 h.head_revision,l.config_revision,l.visibility_epoch,e.visibility_epoch
from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l on l.source_id=h.source_id
join public.cloud_user_catalog_visibility_epochs e on e.user_id=h.user_id cross join generate_series(1,32)n
where h.source_id='96000000-0000-4000-8000-000000000101';

do $test$
declare
 u uuid:='96000000-0000-4000-8000-000000000001'; src uuid:='96000000-0000-4000-8000-000000000101';
 t uuid; j public.cloud_source_credential_transition_jobs%rowtype; r jsonb; before_ids uuid[];
 gen uuid; rev bigint; p jsonb; sums jsonb; xors jsonb; before_cipher text;
 finish_mode text:=coalesce(nullif(current_setting('norva.test_transport_finish',true),''),'success');
begin
 select active_generation_id into gen from public.cloud_source_catalog_heads where source_id=src;
 select array_agg(id order by id) into before_ids from public.cloud_media_items where source_id=src;
 if cardinality(before_ids)<>32 then raise exception 'fixture incomplete'; end if;
 r:=public.norva_create_credential_transition(u,src,'transport-fixture-1',repeat('1',64),0,
   'transport-test-B','{"sourceType":"xtream","serverHost":"candidate.invalid","hasPassword":true}',
   'transport-test',repeat('b',64));
 t:=(r->>'transitionId')::uuid;
 update public.cloud_source_credential_transition_jobs set state='processing',lease_owner='transport-test',
   lease_sequence=lease_sequence+1,lease_until=now()+interval '5 minutes'
   where transition_id=t and job_kind='validate_candidate' returning * into j;
 r:=public.norva_begin_credential_transport_check(j.id,u,'transport-test',j.lease_sequence);
 if r->>'state'<>'CHECKING' or (r->>'generationId')::uuid<>gen then raise exception 'wrong baseline'; end if;
 begin
   perform public.norva_checkpoint_credential_transport_check(j.id,u,'wrong-worker',j.lease_sequence,'movie',null,1);
   raise exception 'wrong lease accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
   perform public.norva_begin_credential_transport_check(j.id,'96000000-0000-4000-8000-000000000002','transport-test',j.lease_sequence);
   raise exception 'another owner accepted';
 exception when sqlstate 'PT409' then null; end;
 -- Independent PostgreSQL lane construction; Gateway parity has its own JS
 -- fixture and streamed-parser regression, rather than faking a ready marker.
 with hashes as(select extensions.digest(jsonb_build_array('media',item_type,external_id,parent_external_id,title)::text,'sha256')h
   from public.cloud_media_items where source_id=src), lanes as(select
   ('x'||substr(encode(h,'hex'),1,16))::bit(64)::bigint a,('x'||substr(encode(h,'hex'),17,16))::bit(64)::bigint b,
   ('x'||substr(encode(h,'hex'),33,16))::bit(64)::bigint c,('x'||substr(encode(h,'hex'),49,16))::bit(64)::bigint d from hashes)
 select jsonb_build_array(sum(a::numeric)::text,sum(b::numeric)::text,sum(c::numeric)::text,sum(d::numeric)::text),
   jsonb_build_array(bit_xor(a)::text,bit_xor(b)::text,bit_xor(c)::text,bit_xor(d)::text) into sums,xors from lanes;
 if finish_mode='mismatch' then sums:=jsonb_set(sums,'{0}',to_jsonb(((sums->>0)::numeric+1)::text)); end if;
 for p in select jsonb_build_object('version',2,'itemType',kind,'eligible',true,
   'count',case when kind='movie' then 32 else 0 end,
   'sums',case when kind='movie' then sums else '["0","0","0","0"]'::jsonb end,
   'xors',case when kind='movie' then xors else '["0","0","0","0"]'::jsonb end)
   from unnest(array['movie','series','live'])kind loop
   if j.state<>'processing' then
     update public.cloud_source_credential_transition_jobs set state='processing',lease_owner='transport-test',
       lease_sequence=lease_sequence+1,lease_until=now()+interval '5 minutes' where id=j.id returning * into j;
   end if;
   r:=public.norva_checkpoint_credential_transport_check(j.id,u,'transport-test',j.lease_sequence,p->>'itemType',p,1);
   select * into j from public.cloud_source_credential_transition_jobs where id=j.id;
 end loop;
 if finish_mode='mismatch' then
   if r->>'state'<>'NOT_MATCHING'
      or (select config_ciphertext from public.cloud_sources where id=src)<>'transport-test-A'
      or (select state from public.cloud_source_transitions where id=t)<>'validating' then
     raise exception 'mismatched inventory reused'; end if;
   raise notice 'Transport mismatch rejected without switching or completing validation';
   return;
 end if;
 if r->>'state'<>'READY' then raise exception 'complete inventory not ready: %',r->>'state'; end if;
 select revision into rev from public.cloud_source_transitions where id=t;
 begin
   perform public.norva_apply_credential_transport_check(t,u,rev+1,0,'transport-stale',repeat('2',64));
   raise exception 'stale transition accepted';
 exception when sqlstate 'PT409' then null; end;
 r:=public.norva_apply_credential_transport_check(t,u,rev,0,'transport-apply',repeat('3',64));
 if lower(r->>'state')<>'committing' then raise exception 'swap not applied'; end if;
 perform public.norva_apply_credential_transport_check(t,u,rev,0,'transport-apply',repeat('3',64));
 if (select config_revision from public.cloud_source_lifecycle where source_id=src)<>1 then
   raise exception 'idempotent apply rotated twice'; end if;
 if (select active_generation_id from public.cloud_source_catalog_heads where source_id=src)<>gen
   or (select array_agg(id order by id) from public.cloud_media_items where source_id=src) is distinct from before_ids
   or exists(select 1 from public.cloud_source_catalog_generations where transition_id=t)
   or exists(select 1 from public.cloud_catalog_background_owner_build_jobs where transition_id=t) then
   raise exception 'address change rebuilt the catalogue'; end if;
 update public.cloud_source_credential_transition_jobs set state='processing',lease_owner='transport-test',
   lease_sequence=lease_sequence+1,lease_until=now()+interval '5 minutes'
   where transition_id=t and job_kind='post_switch_verify' returning * into j;
 r:=public.norva_finish_credential_transport_check(j.id,u,'transport-test',j.lease_sequence,finish_mode='restore',
   case when finish_mode='unavailable' then 'rollback_unavailable' else null end);
 if lower(r->>'state')<>(case when finish_mode='success' then 'completed' else 'failed' end)
   or (select config_ciphertext from public.cloud_sources where id=src)<>(case when finish_mode='restore' then 'transport-test-A' else 'transport-test-B' end)
   or (select manifest_sealing from public.cloud_source_catalog_generations where id=gen) then
   raise exception 'transport completion failed'; end if;
 if exists(select 1 from public.cloud_source_credential_transition_jobs where transition_id=t
   and job_kind in ('build_candidate_generation','promote_generation_titles','purge_terminal_generation')) then
   raise exception 'transport completion queued reconstruction or purge'; end if;
 if exists(select 1 from public.cloud_source_transition_secrets where transition_id=t and cleared_at is null) then
   raise exception 'terminal secret retention failed'; end if;
 if (select active_generation_id from public.cloud_source_catalog_heads where source_id=src)<>gen
   or (select array_agg(id order by id) from public.cloud_media_items where source_id=src) is distinct from before_ids then
   raise exception 'completion changed catalogue identity'; end if;
 raise notice 'Transport fixture passed (%): identity, lease, CAS, idempotency, unchanged rows, no reconstruction, secret cleanup',finish_mode;
end
$test$;
