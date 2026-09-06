"""Explicit full-mail gates and a single internal non-auth proof. No bulk replay."""
import hashlib,json,os,socket,subprocess,sys,time
from pathlib import Path
HOST=Path('/home/adrien/.norva/postal-full-service-v1');GUEST=Path('/var/lib/norva-postal-full-v1')
KEY='postal-full-real-queue-proof-20260906-1'
def sql(q):
 r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-At','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q.encode(),capture_output=True,timeout=20)
 if r.returncode:raise RuntimeError('sql_failed_check_receipts')
 return r.stdout.decode().strip()
def atomic(p,v):
 temp=p.with_name(p.name+'.next')
 with temp.open('x')as f:os.chmod(temp,0o600);json.dump(v,f);f.flush();os.fsync(f.fileno())
 os.replace(temp,p)
def guest(mode):
 assert socket.gethostname()=='norva-postal-offline' and os.geteuid()==0
 p=json.loads((GUEST/'policy.json').read_text())
 for old in ['auth-service-v1','branded-service-v1']:assert not json.loads(Path('/var/lib/norva-postal-'+old+'/policy.json').read_text())['enabled']
 p.update(enabled=mode!='close',testRecipients=None if mode=='production' else ['buildtrack.admin@gmail.com','projethorizon2030@gmail.com'])
 atomic(GUEST/'policy.json',p);print(json.dumps({'guestMode':mode,'emailSent':False}))
def host(mode):
 assert socket.gethostname()=='norva-db' and os.geteuid()==1000
 c=json.loads((HOST/'private/config.json').read_text())
 if mode=='enqueue-proof':
  assert not c['enabled'] and not (HOST/'proof-started.json').exists()
  atomic(HOST/'proof-started.json',{'key':KEY,'at':time.time(),'noReplay':True})
  q="""begin;set local lock_timeout='1s';set local statement_timeout='5s';
do $$declare u auth.users%rowtype;v_id uuid;begin
select * into strict u from auth.users where lower(email)='buildtrack.admin@gmail.com';
if u.email_confirmed_at is null or u.deleted_at is not null or coalesce(u.email_change,'')<>'' or coalesce(u.raw_app_meta_data->>'role','')='admin'
 or not exists(select 1 from public.admin_internal_accounts where user_id=u.id)
 or exists(select 1 from public.cloud_email_suppressions where email=lower(u.email) and active)
 or exists(select 1 from public.cloud_branded_email_outbox where dedupe_key='PROOFKEY')
 then raise exception 'controlled_test_not_allowed';end if;
if exists(select 1 from public.cloud_branded_email_outbox where mail_provider='postal' and state in ('pending','processing') and not exists(select 1 from norva_postal_queue.bindings where outbox_id=cloud_branded_email_outbox.id)) then raise exception 'another_active_job';end if;
v_id:=public.norva_enqueue_branded_email(lower(u.email),'Norva - Full Postal transport test','Full Postal transport test',
'This technical email tests the complete Norva queue through Postal on Hetzner. No account, payment, subscription or security setting has changed. No confirmation is required.',
'Open Norva','https://norva.tv/app','Internal delivery test only.','postal_transport_test','PROOFKEY',u.id);
update public.cloud_branded_email_outbox set mail_provider='postal',request_from='Norva <support@notify.norva.tv>' where id=v_id and state='pending' and attempt_count=0;
if not found then raise exception 'untouched_proof_required';end if;
end$$;
update norva_postal_full.policy set enabled=true,test_only=true;
commit;select row_to_json(c) from public.claim_postal_branded_email_deliveries(1,300,12) c;""".replace('PROOFKEY',KEY)
  claim=json.loads(sql(q));assert claim['delivery_key']=='norva-branded-'+str(claim['id'])
  atomic(HOST/'private/proof-claim.json',claim);c['enabled']=True;atomic(HOST/'private/config.json',c)
  print(json.dumps({'result':'ONE_CONTROLLED_REAL_QUEUE_PROOF_READY','outboxId':claim['id'],'emailSent':False}));return
 if mode=='recover-unsent-proof-claim':
  assert not c['enabled'] and not (HOST/'private/proof-claim.json').exists() and (HOST/'proof-started.json').exists()
  assert sql('select count(*) from norva_postal_full.receipts')=='0'
  claim=json.loads(sql("select row_to_json(o) from public.cloud_branded_email_outbox o where dedupe_key='"+KEY+"' and state='processing' and lease_expires_at>clock_timestamp() and recipient_email='buildtrack.admin@gmail.com' and attempt_count=1 and mail_provider='postal'"))
  atomic(HOST/'private/proof-claim.json',claim);c['enabled']=True;atomic(HOST/'private/config.json',c)
  print(json.dumps({'result':'EXISTING_UNSENT_PROOF_CLAIM_RECOVERED','noNewEnqueue':True}));return
 if mode=='complete-proof':
  c0=json.loads((HOST/'private/proof-claim.json').read_text());q="""select coalesce(json_agg(r),'[]') from (select id,postal_message_id,state,secure from norva_postal_full.receipts where delivery_key='PROOFKEY')r;""".replace('PROOFKEY',c0['delivery_key'])
  rows=json.loads(sql(q));assert len(rows)==1 and rows[0]['state']=='sent' and rows[0]['secure'];r=rows[0]
  values=[str(c0['id']),c0['delivery_key'],str(c0['lease_token']),r['id']];assert all("'"not in x for x in values)
  result=sql("select public.complete_postal_branded_email_delivery('"+"','".join(values)+"',200,'{}');")
  assert result=='t';print(json.dumps({'result':'REAL_QUEUE_COMPLETED_WITH_SMTP_RECEIPT','postalMessageId':r['postal_message_id']}));return
 if mode=='receipts':
  print(sql("select jsonb_build_object('at',clock_timestamp(),'policy',(select jsonb_build_object('enabled',enabled,'testOnly',test_only) from norva_postal_full.policy),'receipts',(select coalesce(jsonb_agg(x),'[]') from(select state,count(*) from norva_postal_full.receipts group by state)x),'events',(select count(*) from norva_postal_full.events),'proof',(select jsonb_build_object('state',state,'resendReceiptAbsent',resend_email_id is null,'postalReceipt',postal_delivery_id,'scrubbed',request_html is null,'sentAt',sent_at) from public.cloud_branded_email_outbox where dedupe_key='"+KEY+"'))"));return
 assert mode in ['close','production','test']
 sql('update norva_postal_full.policy set enabled='+('false' if mode=='close' else 'true,test_only='+('true' if mode=='test' else 'false'))+';')
 c['enabled']=mode!='close';atomic(HOST/'private/config.json',c);print(json.dumps({'hostMode':mode,'emailSent':False}))
if __name__=='__main__':
 os.umask(0o077)
 try:
  assert len(sys.argv)==3;{'host':host,'guest':guest}[sys.argv[1]](sys.argv[2])
 except Exception as e:print(json.dumps({'result':'STOPPED_CHECK_RECEIPTS','errorClass':type(e).__name__,'detailsSuppressed':True}));sys.exit(1)
