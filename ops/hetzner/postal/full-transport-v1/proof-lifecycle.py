"""Synthetic email acceptance in a networkless disposable database; never sends mail."""
import json,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent/'proof'
NAME='norva-email-lifecycle-proof-20260908'

def run(args,data=None,check=True):
 r=subprocess.run(args,input=data,text=True,capture_output=True,timeout=60)
 if check and r.returncode:raise RuntimeError(r.stdout[-1800:]+r.stderr[-3500:])
 return r
def sql(q,target=NAME,database='postgres'):
 args=['docker','exec','-i',target,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',database]
 if target==NAME:args+=['-h','/tmp']
 return run(args,q).stdout
def fixture(name,database='postgres'):
 content=(ROOT/name).read_text()
 # Same welcome assertions against the currently deployed Postal acknowledgement.
 if name=='signup-welcome.integration.sql':content=content.replace('public.complete_branded_email_delivery(', 'public.complete_postal_branded_email_delivery(')
 result=sql(content,database=database)
 print(json.dumps({'fixture':name,'result':result[-350:],'passed':True}),flush=True)

definitions=sql("select pg_get_functiondef(p.oid)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('complete_branded_email_delivery','complete_postal_branded_email_delivery','norva_enqueue_lifecycle_email')) or (n.nspname='norva_postal_full' and p.proname='branded_allowed');",'norva-db')
assert NAME not in run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines()
created=False
try:
 run(['docker','run','-d','--name',NAME,'--label','norva.purpose=email-lifecycle-proof','--network','none','--memory','768m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=512m,mode=1777','--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',"initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
 created=True
 for _ in range(25):
  if run(['docker','exec',NAME,'pg_isready','-h','/tmp','-U','postgres'],check=False).returncode==0:break
  time.sleep(1)
 fixture('signup-welcome.bootstrap.sql')
 sql("""
 create schema norva_postal_full;
 create function norva_postal_full.receipt_is_sent(text,text) returns boolean language sql as 'select true';
 alter table cloud_branded_email_outbox add column flow text,add column dedupe_key text,add column request_from text,
  add column request_tags jsonb,add column mail_provider text default 'postal',add column postal_delivery_id text,add column postal_response jsonb;
 create unique index on cloud_branded_email_outbox(dedupe_key) where dedupe_key is not null;
 create table cloud_revolut_customers(user_id uuid primary key,period text,amount_cents integer,payment_method_id text,revolut_customer_id text);
 """)+sql(definitions)
 fixture('welcome.sql')
 fixture('signup-welcome.integration.sql')
 fixture('billing.sql')
 fixture('billing-email.integration.sql')
 sql('create database behavioral;')
 fixture('behavioral-lifecycle.bootstrap.sql','behavioral')
 fixture('behavioral.sql','behavioral')
 fixture('behavioral-hardening.sql','behavioral')
 fixture('behavioral-lifecycle.integration.sql','behavioral')
 fixture('behavioral-lifecycle.concurrency.sql','behavioral')
 print('EMAIL_LIFECYCLE_PROOF_OK',flush=True)
finally:
 if created:
  c=json.loads(run(['docker','inspect',NAME]).stdout)[0]
  assert c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']=='email-lifecycle-proof'
  run(['docker','rm','-f',NAME])
