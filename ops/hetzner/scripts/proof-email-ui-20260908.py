"""Networkless PostgreSQL proof of the generated email shell; no delivery."""
import json,pathlib,subprocess,time
root=pathlib.Path(__file__).resolve().parent;name='norva-email-ui-proof-20260908'
def run(args,data=None,check=True):
 p=subprocess.run(args,input=data,text=True,capture_output=True,timeout=60)
 if check and p.returncode:raise RuntimeError(p.stderr[-1200:])
 return p
def sql(q,target=name):
 return run(['docker','exec','-i',target,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin' if target=='norva-db' else 'postgres','-d','postgres']+(['-h','/tmp'] if target==name else []),q).stdout
escape=sql("select pg_get_functiondef(p.oid)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='norva_html_escape';",'norva-db')
assert name not in run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines()
try:
 run(['docker','run','-d','--name',name,'--label','norva.purpose=email-ui-proof','--network','none','--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777','--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',"initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
 for _ in range(25):
  if run(['docker','exec',name,'pg_isready','-h','/tmp','-U','postgres'],check=False).returncode==0:break
  time.sleep(1)
 sql(escape+(root/'premium-email-ui.sql').read_text())
 print(sql((root/'premium-email-ui-proof.sql').read_text()).strip())
finally:
 c=json.loads(run(['docker','inspect',name]).stdout)[0]
 assert c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']=='email-ui-proof'
 run(['docker','rm','-f',name])
