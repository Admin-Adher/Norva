"""Execute email coverage assertions in a disposable networkless PostgreSQL."""
import json,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent/'coverage-proof'
NAME='norva-email-coverage-proof-20260908'
LABEL='email-coverage-proof'
def run(args,data=None,check=True):
 r=subprocess.run(args,input=data,text=True,capture_output=True,timeout=60)
 if check and r.returncode:raise RuntimeError(r.stdout[-1000:]+r.stderr[-4500:])
 return r
def sql(q):
 return run(['docker','exec','-i',NAME,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'],q).stdout
files=[
 'behavioral-lifecycle.bootstrap.sql','20260903180000_behavioral_lifecycle_engine_v1.sql',
 '20260904090000_behavioral_lifecycle_import_readiness_append_only.sql',
 '20260904100000_behavioral_lifecycle_admin_overview_digest_schema.sql',
 '20260905160000_lifecycle_timezone_provenance.sql',
 '20260908160531_suppress_import_reminder_for_usable_catalog.sql',
 'email-coverage.bootstrap.sql','20260908183015_complete_email_coverage.sql',
 'email-coverage.integration.sql',
]
assert NAME not in run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines()
created=False
try:
 run(['docker','run','-d','--name',NAME,'--label','norva.purpose='+LABEL,'--network','none','--memory','768m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=512m,mode=1777','--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',"initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
 created=True
 for _ in range(25):
  if run(['docker','exec',NAME,'pg_isready','-h','/tmp','-U','postgres'],check=False).returncode==0:break
  time.sleep(1)
 for name in files:
  if name=='20260908183015_complete_email_coverage.sql':
   baseline=(ROOT/'20260722003000_lifecycle_email_delivery_outbox.sql').read_text().replace('\r\n','\n')
   start=baseline.index('create or replace function public.norva_enqueue_lifecycle_email(')
   sql(baseline[start:baseline.index('$function$;',start)+len('$function$;')])
  result=sql((ROOT/name).read_text().replace('\r\n','\n'))
  print(json.dumps({'file':name,'passed':True,'result':result[-100:]}),flush=True)
 print('EMAIL_COVERAGE_PROOF_OK',flush=True)
finally:
 if created:
  c=json.loads(run(['docker','inspect',NAME]).stdout)[0]
  assert c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']==LABEL
  run(['docker','rm','-f',NAME])
