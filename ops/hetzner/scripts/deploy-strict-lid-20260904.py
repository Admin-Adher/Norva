"""Scoped operator deployment, never an unattended updater. Secrets stay on host."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,time,urllib.request
os.umask(0o077)
root=pathlib.Path('/home/adrien/.norva/strict-lid-permanent-20260904-r3')
src=root/'candidate'
def run(args,data=None):
 p=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode: raise RuntimeError('command_failed:'+args[0]+':'+str(p.returncode))
 return p.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def health(name,path='/health'):
 c=inspect(name);e=dict(x.split('=',1) for x in c['Config']['Env'] if '=' in x)
 ip=c['NetworkSettings']['Networks']['norva_default']['IPAddress']
 port=e.get('PORT','9000' if name.startswith('norva-edge') else '8080')
 req=urllib.request.Request('http://'+ip+':'+port+path,headers={'Authorization':'Bearer '+e.get('NORVA_BACKFILL_TOKEN','')})
 return json.load(urllib.request.urlopen(req,timeout=30))
def command(c):
 l=c['Config']['Labels'];args=['docker','compose','-p',l['com.docker.compose.project']]
 for f in l.get('com.docker.compose.project.environment_file','').split(','):
  if f:args+=['--env-file',f]
 for f in l['com.docker.compose.project.config_files'].split(','):args+=['-f',f]
 return args
def sql(s):return run(['docker','exec','-i','norva-db','psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],s.encode()).decode().strip()
phase=sys.argv[1]
if phase=='stage':
 assert not (root/'plan.json').exists(),'Existing plan: inspect rather than overwrite'
 gw=inspect('norva-media-gateway');edge=inspect('norva-edge-functions')
 expected={'index.js':'73683d1ef9420141e1bcec62ddf3c603bb32a241165351eed3edd98de2d1b3a9','strict-lid-batch.js':'83141c3aeace3f39e0d1f09dc2a8cb01aedc0555d9e4bee88434e117677c81fe'}
 for name,digest in expected.items():
  raw=run(['docker','exec','norva-media-gateway','cat','/app/src/'+name]).replace(b'\r\n',b'\n')
  assert hashlib.sha256(raw).hexdigest()==digest,'Gateway source drift'
 previous=next(m['Source'] for m in edge['Mounts'] if m['Destination']=='/home/deno/functions')
 assert hashlib.sha256((pathlib.Path(previous)/'norva-admin/index.ts').read_bytes().replace(b'\r\n',b'\n')).hexdigest()=='fc6e03e78d855c9c449ee0eb252e1b99c6abf125f4cc02e7dbce70d4a435ae2c','Admin source drift'
 shutil.copytree(previous,root/'functions',dirs_exist_ok=True)
 for rel in ['norva-admin/index.ts','_shared/strict-lid-health.mjs']:
  shutil.copyfile(src/'supabase/functions'/rel,root/'functions'/rel)
  (root/'functions'/rel).chmod(0o644)
 image='norva-media-gateway:strict-lid-20260904-r3'
 build=root/'gateway-build';build.mkdir(exist_ok=True)
 for name in ['index.js','strict-lid-batch.js','strict-lid-inference.js']:
  shutil.copyfile(src/'services/media-gateway/src'/name,build/name)
 # Build only the reviewed JS delta on the exact already-running image.
 (build/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY --chmod=0644 index.js strict-lid-batch.js strict-lid-inference.js /app/src/\n')
 run(['docker','tag',gw['Image'],'norva-strict-lid-base:fac9d36b'])
 run(['docker','build','--build-arg','BASE_IMAGE=norva-strict-lid-base:fac9d36b','-t',image,str(build)])
 for name in ['index.js','strict-lid-batch.js','strict-lid-inference.js']:
  run(['docker','run','--rm','--network','none','--user',gw['Config']['User'] or '0','--entrypoint','node',image,'--check','/app/src/'+name])
 plan={'oldImage':gw['Image'],'oldFunctions':previous,'image':image,'gatewayId':gw['Id'],'edgeIds':{n:inspect(n)['Id'] for n in ['norva-edge-functions','norva-edge-functions-2']}}
 for kind,c,change in [('gateway',gw,{'gateway':{'image':image}}),('edge',edge,{'functions':{'volumes':[str(root/'functions')+':/home/deno/functions:ro']},'functions2':{'volumes':[str(root/'functions')+':/home/deno/functions:ro']}})]:
  base=command(c);override=root/(kind+'-override.json');override.write_text(json.dumps({'services':change}))
  before=json.loads(run(base+['config','--format','json']));after=json.loads(run(base+['-f',str(override),'config','--format','json']))
  for service in change:
   a=before['services'][service];b=after['services'][service]
   allowed='image' if kind=='gateway' else 'volumes'
   assert {k:v for k,v in a.items() if k!=allowed}=={k:v for k,v in b.items() if k!=allowed},'Unrelated compose drift'
   if kind=='edge':
    assert [v for v in a['volumes'] if v['target']!='/home/deno/functions']==[v for v in b['volumes'] if v['target']!='/home/deno/functions']
  plan[kind+'Command']=base+['-f',str(override)]
 (root/'plan.json').write_text(json.dumps(plan))
 print(json.dumps({'staged':True,'image':image,'oldImage':gw['Image'],'unrelatedComposePreserved':True}))
elif phase=='migration':
 assert sql("select to_regprocedure('public.strict_lid_runtime_health()') is null")=='t','Migration already installed'
 migration=(src/'supabase/migrations/20260904211500_strict_lid_permanent_supervision.sql').read_text()
 sql(migration)
 print(sql('select public.strict_lid_runtime_health();'))
elif phase in ['gateway','functions','functions2']:
 plan=json.loads((root/'plan.json').read_text());name='norva-media-gateway' if phase=='gateway' else ('norva-edge-functions-2' if phase=='functions2' else 'norva-edge-functions')
 before=inspect(name)
 assert before['Id']==(plan['gatewayId'] if phase=='gateway' else plan['edgeIds'][name]),'Container changed since preflight'
 if phase=='gateway':
  h=health(name)
  for field in ['activeSessions','activeStrictLidBrokers','whisperInferenceActive','backgroundCpuProcessCount','rawPumpCount','viewerStartupReservations','viewerSessionStartupAdmissions','transcribeQueueDepth','ocrQueueDepth','translateQueueDepth']:
   assert h.get(field)==0,'Active work or missing health field: do not interrupt'
  assert h.get('languageWavExtraction',{}).get('active')==0,'Active extraction or missing health field'
  for field in ['transcribeBusy','ocrBusy','translateBusy','lidBenchmarkBusy','viewerPlaybackActiveLocally']:
   assert h.get(field) is False,'Active work or missing health field: do not interrupt'
 run(plan['gatewayCommand' if phase=='gateway' else 'edgeCommand']+['up','-d','--no-deps','--no-build','--force-recreate',phase])
 after=inspect(name)
 assert sorted(after['Config']['Env'])==sorted(before['Config']['Env']),'Environment drift'
 for key in ['Binds','PortBindings','Memory','NanoCpus','Devices','GroupAdd','SecurityOpt','CapDrop']:
  if key=='Binds' and phase!='gateway':continue
  left=after['HostConfig'].get(key);right=before['HostConfig'].get(key)
  if isinstance(left,list) and isinstance(right,list):
   left=sorted(left,key=lambda v:json.dumps(v,sort_keys=True));right=sorted(right,key=lambda v:json.dumps(v,sort_keys=True))
  assert left==right,'Host setting drift:'+key
 for attempt in range(20):
  try:
   h=health(name,'/health' if phase=='gateway' else '/norva-playback/health')
   if h.get('ok') is True:break
  except Exception:pass
  time.sleep(1)
 assert h.get('ok') is True,'Readiness failed'
 if phase=='gateway':assert h.get('strictLidInference',{}).get('protocol')==1 and h.get('version')==166
 else:
  assert hashlib.sha256(run(['docker','exec',name,'cat','/home/deno/functions/_shared/strict-lid-health.mjs'])).digest()==hashlib.sha256((root/'functions/_shared/strict-lid-health.mjs').read_bytes()).digest()
 print(json.dumps({'deployed':name,'healthy':True,'environmentPreserved':True,'version':h.get('version'),'strictLidInference':h.get('strictLidInference')}))
else:raise RuntimeError('Unknown phase')
