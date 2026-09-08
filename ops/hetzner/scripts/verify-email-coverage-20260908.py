"""Verify deployed email producers and normal lifecycle cron, without payments."""
import hashlib,json,pathlib,subprocess,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
def run(args,data=None):
 p=subprocess.run(args,input=data,text=True,capture_output=True,timeout=60)
 if p.returncode:raise RuntimeError('Private command failed')
 return p.stdout.strip()
def sql(q):return run(['docker','exec','-i','norva-db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],q)
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def env(c):return dict(v.split('=',1) for v in c['Config']['Env'] if '=' in v)
def request(c,path,token,payload=None):
 ip=c['NetworkSettings']['Networks']['norva_default']['IPAddress']
 req=urllib.request.Request('http://'+ip+':9000/'+path,data=json.dumps(payload).encode() if payload is not None else None,
  headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=45) as r:return json.load(r)
replicas=[]
for name in ['norva-edge-functions','norva-edge-functions-2']:
 c=inspect(name);e=env(c)
 for flag in ['NORVA_LIFECYCLE_BILLING_LIVE','NORVA_LC_DUNNING','NORVA_LC_RENEWAL','NORVA_LC_WINBACK','NORVA_LC_ABANDONED']:assert e.get(flag)=='true'
 assert e.get('NORVA_LC_EXPIRE','false')=='false'
 assert e.get('NORVA_OPS_EMAIL')=='buildtrack.admin@gmail.com'
 assert request(c,'norva-lifecycle/health','')['ok']
 replicas.append({'name':name,'healthy':True,'email_flags_enabled':True,'financial_expiry_disabled':True,'ops_email_configured':True})
secret=sql("select decrypted_secret from vault.decrypted_secrets where name='norva_cron_shared_secret';")
assert len(secret)>20
cron=request(inspect('norva-edge-functions'),'norva-lifecycle/cron/run',secret,{})
assert cron.get('marketing_ready') is True and all(cron['enabled'][x] for x in ['dunning','renewal','winback','abandoned']) and not cron['enabled']['expire']
db=json.loads(sql("""begin read only;select jsonb_build_object(
 'runtime',(select jsonb_build_object('mode',audience_mode,'stopped',emergency_stop) from public.behavioral_lifecycle_runtime),
 'active_journeys',(select count(*) from public.behavioral_lifecycle_journeys where status='active' and rollout_percent=100 and holdout_percent=0),
 'security_triggers',(select count(*) from pg_trigger where tgname in ('norva_mfa_factor_notice_trg','norva_identity_notice_trg','norva_phone_notice_trg') and tgenabled='O'),
 'preview_outbox_sent',(select count(*) from public.cloud_branded_email_outbox where dedupe_key like 'email-coverage-preview-20260908:%' and state='sent'),
 'preview_smtp_sent',(select count(*) from norva_postal_full.receipts r join public.cloud_branded_email_outbox e using(delivery_key) where e.dedupe_key like 'email-coverage-preview-20260908:%' and r.state='sent'),
 'branded_overdue',(select count(*) from public.cloud_branded_email_outbox where state in ('pending','processing') and next_attempt_at<now()-interval '20 minutes'),
 'branded_new_deadletters',(select count(*) from public.cloud_branded_email_outbox where state='dead_letter' and created_at>='2026-09-08T18:30:00Z'),
 'provider_stage',(select stage from public.cloud_provider_access_rollout),
 'provider_email',(select enabled from public.admin_feature_flags where key='provider_access_email_v1_enabled'),
 'ops_policy',(select 'buildtrack.admin@gmail.com'=any(ops_recipients) from norva_postal_full.policy));rollback;"""))
assert db['runtime']=={'mode':'production','stopped':False} and db['active_journeys']==4
assert db['security_triggers']==3 and db['preview_outbox_sent']==11 and db['preview_smtp_sent']==11
assert db['branded_overdue']==0 and db['branded_new_deadletters']==0
assert db['provider_stage']=='20_percent' and db['provider_email'] and db['ops_policy']
proof={'replicas':replicas,'lifecycle_cron':cron,'database':db,'payments_triggered':False}
(ROOT/'verified.json').write_text(json.dumps(proof,indent=2))
print(json.dumps(proof))
