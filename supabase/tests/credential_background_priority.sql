-- Run in a caller-owned transaction and always ROLLBACK. Synthetic data only.
set local request.jwt.claim.role='service_role';
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
 raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'priority-fixture-'||n||'@invalid.test','',now(),'{}','{}',now(),now()
from generate_series(1,3)n;
insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,
 sync_status,catalog_version,enabled,last_synced_at)
select ('97000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
 ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'xtream','Priority fixture','priority-test','{}','ready',1,true,now()
from generate_series(1,3)n;
insert into public.cloud_source_provider_account_affinities(source_id,user_id,affinity_hash)
select ('97000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
 ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n<3 then repeat('9',64) else repeat('8',64) end
from generate_series(1,3)n;
do $fixture$
begin
 if public.norva_credential_work_pending_for_owner('97000000-0000-4000-8000-000000000001') then
   raise exception 'idle owner blocked'; end if;
 perform public.norva_create_credential_transition(
   '97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000101',
   'priority-fixture',repeat('7',64),0,'priority-next',
   '{"sourceType":"xtream","serverHost":"candidate.invalid","hasPassword":true}',
   'priority-test',repeat('6',64));
 if has_table_privilege('service_role','public.cloud_source_credential_transition_jobs','select') then
   raise exception 'private jobs table exposed'; end if;
 if has_function_privilege('authenticated','public.norva_credential_work_pending_for_owner(uuid)','execute')
 or has_function_privilege('anon','public.norva_credential_work_pending_for_owner(uuid)','execute') then
   raise exception 'private gate exposed'; end if;
end
$fixture$;
-- Exercise the real SQL role, not just a mock or JWT claim.
set local role service_role;
do $fixture$
begin
 if not public.norva_credential_work_pending_for_owner('97000000-0000-4000-8000-000000000001') then
   raise exception 'job owner not protected'; end if;
 if not public.norva_credential_work_pending_for_owner('97000000-0000-4000-8000-000000000002') then
   raise exception 'shared provider account not protected'; end if;
 if public.norva_credential_work_pending_for_owner('97000000-0000-4000-8000-000000000003') then
   raise exception 'unrelated provider account blocked'; end if;
end
$fixture$;
reset role;
update public.cloud_source_credential_transition_jobs set state='completed',completed_at=now()
where user_id='97000000-0000-4000-8000-000000000001';
set local role service_role;
do $fixture$
begin
 if public.norva_credential_work_pending_for_owner('97000000-0000-4000-8000-000000000002') then
   raise exception 'completed work still blocks background'; end if;
end
$fixture$;
reset role;
