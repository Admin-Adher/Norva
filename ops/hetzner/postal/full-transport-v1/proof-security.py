import json,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent;NAME='norva-email-security-proof-20260908'
def run(args,data=None,check=True):
 r=subprocess.run(args,input=data,text=True,capture_output=True,timeout=60)
 if check and r.returncode:raise RuntimeError(r.stderr[-2000:])
 return r
def sql(q,target=NAME):
 args=['docker','exec','-i',target,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres']
 if target==NAME:args+=['-h','/tmp']
 return run(args,q).stdout
functions=sql("select pg_get_functiondef(p.oid)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('norva_notify_password_changed','norva_notify_email_changed');",'norva-db')
bootstrap="""
create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
create role anon;create role authenticated;create role norva_postal_full_worker;
create schema norva_postal_full;
create table auth.users(id uuid,email text,encrypted_password text,email_confirmed_at timestamptz,updated_at timestamptz);
create table captured_email(id uuid default gen_random_uuid(),recipient text,flow text,dedupe text unique);
create function public.norva_html_escape(text) returns text language sql as 'select $1';
create function public.norva_enqueue_branded_email(text,text,text,text,text,text,text,text,text,uuid) returns uuid language plpgsql as $$declare v uuid;begin
 insert into captured_email(recipient,flow,dedupe) values($1,$8,$9) on conflict(dedupe) do update set dedupe=excluded.dedupe returning id into v;return v;end$$;
create table norva_postal_full.receipts(auth boolean,state text,created_at timestamptz);
create table cloud_import_notifications(delivery_key uuid,status text,created_at timestamptz);
create table cloud_branded_email_outbox(state text,flow text,created_at timestamptz,next_attempt_at timestamptz);
create table cloud_support_email_outbox(state text,next_attempt_at timestamptz);
create table cloud_billing_receipt_outbox(sent_at timestamptz,exhausted_at timestamptz,next_attempt_at timestamptz);
"""
assert NAME not in run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines()
try:
 run(['docker','run','-d','--name',NAME,'--label','norva.purpose=email-security-proof','--network','none','--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777','--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',"initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
 for _ in range(25):
  if run(['docker','exec',NAME,'pg_isready','-h','/tmp','-U','postgres'],check=False).returncode==0:break
  time.sleep(1)
 sql(bootstrap+functions)
 sql((ROOT/'security.sql').read_text())
 print(sql((ROOT/'security-proof.sql').read_text()).strip())
 print(sql("select norva_postal_full.delivery_health(); insert into norva_postal_full.receipts values(true,'failed',now()); do $$begin if (norva_postal_full.delivery_health()->>'auth_failures_24h')::int<>1 then raise exception 'monitor failed';end if; if has_function_privilege('authenticated','norva_postal_full.delivery_health()','execute') then raise exception 'monitor public';end if;end$$;"))
finally:
 c=json.loads(run(['docker','inspect',NAME]).stdout)[0];assert c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']=='email-security-proof'
 run(['docker','rm','-f',NAME])
