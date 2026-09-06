"""One authorized technical email through the normal production cron worker."""
import importlib.util,json,os,socket,sys,time
from pathlib import Path
source=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('control',source/'control.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
assert socket.gethostname()=='norva-db' and os.geteuid()==1000
key='postal-full-production-worker-proof-20260906-1'
if sys.argv[1:]==['--enqueue-once']:
 marker=c.HOST/'production-proof-started.json';assert not marker.exists()
 c.atomic(marker,{'key':key,'at':time.time(),'noReplay':True})
 q="""begin;set local statement_timeout='5s';
do $$declare u auth.users%rowtype;v uuid;begin
select * into strict u from auth.users where lower(email)='buildtrack.admin@gmail.com';
if u.email_confirmed_at is null or u.deleted_at is not null or coalesce(u.raw_app_meta_data->>'role','')='admin'
 or not exists(select 1 from public.admin_internal_accounts where user_id=u.id)
 or exists(select 1 from public.cloud_email_suppressions where email=lower(u.email) and active)
 or exists(select 1 from public.cloud_branded_email_outbox where dedupe_key='PROOFKEY')then raise exception 'not_controlled_test';end if;
v:=public.norva_enqueue_branded_email(lower(u.email),'Norva - Production worker test','Production worker test',
'This technical message was queued in Norva and is being processed by the normal production email worker, using Postal on Hetzner. No account, payment or subscription was changed. No confirmation is required.',
'Open Norva','https://norva.tv/app','Internal delivery verification only.','postal_transport_test','PROOFKEY',u.id);
if not exists(select 1 from public.cloud_branded_email_outbox where id=v and mail_provider='postal')then raise exception 'wrong_default_provider';end if;
end$$;commit;""".replace('PROOFKEY',key)
 c.sql(q);print(json.dumps({'result':'ONE_PRODUCTION_QUEUE_TEST_ENQUEUED','manualDrain':False}))
elif sys.argv[1:]==['--status']:
 print(c.sql("select jsonb_build_object('observedAt',clock_timestamp(),'proof',(select jsonb_build_object('id',id,'state',state,'attempts',attempt_count,'provider',mail_provider,'lastHttp',last_http_status,'error',last_error,'sentAt',sent_at,'postalId',postal_delivery_id,'resendIdAbsent',resend_email_id is null,'scrubbed',request_html is null)from public.cloud_branded_email_outbox where dedupe_key='"+key+"'))"))
else:raise ValueError('explicit_mode')
