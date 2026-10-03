"""Reviewed metadata catchup release: staged code, isolated SQL proof, canary,
then sequential identical replicas. No credentials or raw runtime config output.
"""
import argparse,hashlib,json,os,shutil,subprocess,time,urllib.request,urllib.error
from pathlib import Path
ROOT=Path('/home/adrien/.norva/provider-audio-catchup-20261003')
STACK=Path('/home/adrien/norva/ops/hetzner')
CANARY='norva-audio-metadata-edge-canary-20261003'
NAMES=['norva-edge-functions','norva-edge-functions-2']

def run(args,data=None,timeout=90):
 p=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if p.returncode:
  (ROOT/'deployment-error.private.txt').write_bytes(p.stderr)
  raise RuntimeError('deployment_command_failed')
 return p.stdout.decode()
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def sha(path):return hashlib.sha256(path.read_text().encode()).hexdigest()
def ip(info):return next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
def call(info,path,body=None):
 env=dict(v.split('=',1) for v in info['Config']['Env'])
 req=urllib.request.Request('http://'+ip(info)+':9000/'+path,
  data=json.dumps(body).encode() if body is not None else None,
  headers={'Content-Type':'application/json','Authorization':'Bearer '+env['NORVA_BACKFILL_TOKEN']})
 try:
  with urllib.request.urlopen(req,timeout=110) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:
  # The private receipt can contain an internal error. Never echo it.
  (ROOT/'response-error.private.txt').write_bytes(e.read())
  raise RuntimeError('edge_status_'+str(e.code))
def health(name):
 status,body=call(inspect(name),'norva-playback/health')
 assert status==200 and body.get('ok') and body.get('version')==85,'edge_health_failed'
def sql(text):return run(['docker','exec','-i','norva-db','psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],text.encode())
def manifest():return json.loads((ROOT/'language-deploy-manifest.json').read_text())
def runtime(info):return Path(next(m['Source'] for m in info['Mounts'] if m['Destination']=='/home/deno/functions'))
def assert_reference():
 before={name:inspect(name) for name in NAMES}; roots=[runtime(x) for x in before.values()]
 assert roots[0]==roots[1],'replica_runtime_drift'
 for f,h in manifest()['expected'].items():assert sha(roots[0]/f)==h,'live_reference_drift_'+f
 for name in NAMES:health(name)
 return before,roots[0]
def stage():
 before,old=assert_reference();target=ROOT/'runtime-functions'
 assert not target.exists(),'already_staged'
 staged=ROOT/'staged';staged.mkdir()
 run(['tar','-xf',str(ROOT/'language-catchup-edge.tar'),'-C',str(staged),'--strip-components=2'])
 shutil.copytree(old,target)
 for f,h in manifest()['files'].items():
  assert sha(staged/f)==h,'staged_source_drift'
  (target/f).write_text((staged/f).read_text())
 (ROOT/'baseline.private.json').write_text(json.dumps(before))
 print(json.dumps({'staged':True,'files':len(manifest()['files']),'revision':manifest()['revision']}))
def canary():
 before,_=assert_reference();old=before[NAMES[0]];target=ROOT/'runtime-functions'
 assert target.is_dir()
 envfile=ROOT/'canary.env';envfile.write_text('\n'.join(old['Config']['Env'])+'\n');envfile.chmod(0o600)
 network=next(iter(old['NetworkSettings']['Networks']))
 args=['docker','run','-d','--name',CANARY,'--label','norva.purpose=provider-audio-catchup-20261003',
  '--network',network,'--env-file',str(envfile),'--memory','1g','--cpus','1','--pids-limit','256']
 for m in old['Mounts']:
  assert m['Type'] in ('bind','volume'),'unsupported_mount'
  src=str(target) if m['Destination']=='/home/deno/functions' else (m['Name'] if m['Type']=='volume' else m['Source'])
  args+=['-v',src+':'+m['Destination']+('' if m['RW'] else ':ro')]
 entry=old['Config'].get('Entrypoint') or []
 if entry:args+=['--entrypoint',entry[0]]
 args+=[old['Image']]+entry[1:]+(old['Config'].get('Cmd') or [])
 run(args)
 for attempt in range(20):
  try:health(CANARY);break
  except Exception:
   if attempt==19:raise
   time.sleep(1)
 print(json.dumps({'canaryHealthy':True,'productionReplicasChanged':0}))
def migrate():
 assert_reference()
 assert sql("select to_regclass('public.catalog_provider_audio_metadata_sweeps') is null").strip()=='t','migration_already_present'
 migration=ROOT/'20261003121000_provider_audio_metadata_catchup.sql'
 sql(migration.read_text());print(json.dumps({'migrationApplied':migration.name}))
def observe(name,source):
 assert source in ['Dino','MAX OTT','Strng IPTV 8K']
 statement="""set default_transaction_read_only=on;set statement_timeout='15s';
 with owners as(select user_id from cloud_catalog_visible_sources group by user_id
 having bool_or(display_name='Dino') and bool_or(display_name='MAX OTT'))
 select json_build_object('userId',s.user_id,'sourceId',s.id) from cloud_catalog_visible_sources s join owners o using(user_id)
 where s.display_name='"""+source+"' and (select count(*) from owners)=1;"
 rows=[x for x in sql(statement).splitlines() if x.startswith('{')];assert len(rows)==1,'ambiguous_qa_source'
 body={**json.loads(rows[0]),'type':'movie','providerMetadataOnly':True}
 at=time.monotonic();status,value=call(inspect(name),'norva-playback/audio-backfill',body)
 keys=['mode','processed','attempted','identified','inconclusive','failed','deferred','scanned','skipped','hasMore']
 result={'source':source,'status':status,'seconds':round(time.monotonic()-at,2),**{k:value[k] for k in keys if k in value}}
 with (ROOT/'live-results.safe.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
 print(json.dumps(result))
def apply():
 before,_=assert_reference();target=ROOT/'runtime-functions'
 for f,h in manifest()['files'].items():assert sha(target/f)==h,'candidate_drift'
 # Do not restart an Edge executing a leased catalogue/language task.
 busy=sql("""set statement_timeout='5s';select
 (select count(*) from catalog_enrichment_source_schedule where lease_until>now())+
 (select count(*) from catalog_vod_language_intake where state='leased' and lease_until>now())+
 (select count(*) from catalog_provider_audio_metadata_retries where lease_until>now())+
 (select count(*) from catalog_file_audio_validation_jobs where state in ('running','finalizing') and lease_expires_at>now());""").strip()
 assert busy=='0','active_edge_work_defer'
 env_path=STACK/'.env';original=env_path.read_text();lines=original.splitlines()
 assert sum(l.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') for l in lines)==1
 backup=ROOT/'stack-before.env';assert not backup.exists();backup.write_text(original);backup.chmod(0o600)
 compose=['docker','compose','--env-file',str(env_path),'-f',str(STACK/'docker-compose.supabase.yml')]
 env_path.write_text('\n'.join('NORVA_EDGE_FUNCTIONS_ROOT='+str(target) if l.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') else l for l in lines)+'\n')
 changed=[]
 try:
  configured=json.loads(run(compose+['config','--format','json']))
  for name,service in zip(NAMES,['functions','functions2']):
   conf=configured['services'][service];old_env=dict(v.split('=',1) for v in before[name]['Config']['Env'])
   assert all(str(v or '')==old_env.get(k,'') for k,v in conf['environment'].items()),'environment_drift'
   assert any(v.get('source')==str(target) and v.get('target')=='/home/deno/functions' for v in conf['volumes'])
   changed.append(service);run(compose+['up','-d','--no-deps','--force-recreate',service])
   for attempt in range(15):
    try:health(name);break
    except Exception:
     if attempt==14:raise
     time.sleep(2)
   assert inspect(name)['Image']==before[name]['Image'],'image_drift'
   print(json.dumps({'replica':name,'healthy':True}),flush=True)
 except Exception:
  env_path.write_text(original)
  for service in changed:run(compose+['up','-d','--no-deps','--force-recreate',service])
  raise
 receipt={'at':time.time(),'revision':manifest()['revision'],'files':manifest()['files'],'replicas':2}
 (ROOT/'deployment.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':
 os.umask(0o077)
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['stage','canary','migrate','observe','apply']);p.add_argument('--source',default='Dino');p.add_argument('--production',action='store_true');args=p.parse_args()
 if args.mode=='observe':observe(NAMES[0] if args.production else CANARY,args.source)
 else:globals()[args.mode]()
