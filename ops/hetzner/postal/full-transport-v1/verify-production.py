"""Read-only bounded proof; never prints bodies, credentials or customer identities."""
import hashlib,json,os,socket,subprocess,urllib.request,urllib.error
from pathlib import Path
R=Path('/home/adrien/.norva/postal-full-service-v1');E=Path('/home/adrien/.norva/postal-full-edge-20260906-v1')
def run(a,data=None):
 p=subprocess.run(a,input=data,capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('verification_command_failed')
 return p.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def sql(q):return run(['docker','exec','-i','norva-db','psql','-X','-At','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],q.encode()).decode().strip()
assert socket.gethostname()=='norva-db'and os.geteuid()==1000
out={'replicas':[]}
for name in ['norva-edge-functions','norva-edge-functions-2']:
 c=inspect(name);env=dict(e.split('=',1)for e in c['Config']['Env']if '='in e)
 source=Path(next(m['Source']for m in c['Mounts']if m['Destination']=='/home/deno/functions'))
 senders=['norva-auth-email','norva-auth-challenge','norva-support','norva-account-delete','norva-import-notify','norva-revolut-billing','norva-provider-access-notify','norva-playback']
 assert source==E/'functions'and not env.get('RESEND_API_KEY')and len(env.get('NORVA_POSTAL_WIRE_KEY',''))==64
 for n in senders:
  code=(source/n/'index.ts').read_text();assert 'requestEmailProvider'in code and 'https://api.resend.com/emails'not in code and 'RESEND_API_KEY'not in code
 shared=(source/'_shared/email-provider-request.mjs').read_text();assert 'http://norva-private-mail-gateway:18185/v1/mail'in shared
 out['replicas'].append({'name':name,'running':c['State']['Running'],'sendingBoundariesOnPostal':len(senders),'resendKeyPresent':False,'source':str(source)})
gateway=inspect('norva-private-mail-gateway');assert not gateway['HostConfig']['PortBindings']
out['privateGateway']={'noPublicPorts':True,'noSecretsMount':len(gateway['Mounts'])==1 and gateway['Mounts'][0]['Destination']=='/bridge','restart':gateway['HostConfig']['RestartPolicy']['Name']}
retired=inspect('norva-resend-contact-worker');assert not retired['State']['Running']and retired['HostConfig']['RestartPolicy']['Name']=='no'
out['resendContactWorkerStopped']=True
out['health']=json.load(urllib.request.urlopen('http://172.18.0.1:18185/health',timeout=4))
out['database']=json.loads(sql("select jsonb_build_object('enabled',(select enabled from norva_postal_full.policy),'testOnly',(select test_only from norva_postal_full.policy),'receipts',(select coalesce(jsonb_agg(x),'[]') from(select state,auth,count(*) from norva_postal_full.receipts group by 1,2)x),'historicalResendSent',(select count(*) from public.cloud_branded_email_outbox where mail_provider='resend'and state='sent'),'pendingResend',(select count(*) from public.cloud_branded_email_outbox where mail_provider='resend'and state in('pending','processing')),'normalWorkerProof',(select jsonb_build_object('state',state,'attempts',attempt_count,'nextAttemptAt',next_attempt_at,'sentAt',sent_at,'provider',mail_provider,'postalReceipt',postal_delivery_id is not null,'noResendReceipt',resend_email_id is null,'payloadScrubbed',request_html is null)from public.cloud_branded_email_outbox where dedupe_key='postal-full-production-worker-proof-20260906-1'))"))
out['observedAt']=sql('select clock_timestamp()')
print(json.dumps(out))
