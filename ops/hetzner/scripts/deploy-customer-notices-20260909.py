"""Scoped rolling Edge and Auth deployment, preserving live overlays and secrets."""
import difflib,hashlib,json,os,pathlib,shutil,subprocess,sys,time,urllib.request,urllib.error
os.umask(0o077)
ROOT=pathlib.Path(__file__).resolve().parent
assert ROOT==pathlib.Path('/home/adrien/.norva/customer-notices-20260909')
NAMES={'functions':'norva-edge-functions','functions2':'norva-edge-functions-2','auth':'norva-auth'}
FLAGS={'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED':'true',
       'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI':'pg-functions://postgres/norva_notices/password_verification_attempt'}
def run(args):
 p=subprocess.run(args,capture_output=True,timeout=90)
 if p.returncode:raise RuntimeError('deployment command failed: '+args[0])
 return p.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def env(c):return dict(x.split('=',1) for x in c['Config']['Env'] if '=' in x)
def digest(p):return hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()
def compose(c):
 labels=c['Config']['Labels'];args=['docker','compose','-p',labels['com.docker.compose.project']]
 for path in labels.get('com.docker.compose.project.environment_file','').split(','):
  if path:args+=['--env-file',path]
 for path in labels['com.docker.compose.project.config_files'].split(','):args+=['-f',path]
 return args
def healthy(service):
 c=inspect(NAMES[service]);ip=c['NetworkSettings']['Networks']['norva_default']['IPAddress']
 if service=='auth':return json.load(urllib.request.urlopen('http://'+ip+':9999/health',timeout=10)).get('version') is not None
 for route in ['norva-lifecycle','norva-playback']:
  req=urllib.request.Request('http://'+ip+':9000/'+route+'/health',headers={'Authorization':'Bearer '+env(c).get('NORVA_BACKFILL_TOKEN','')})
  if json.load(urllib.request.urlopen(req,timeout=15)).get('ok') is not True:return False
 try:urllib.request.urlopen('http://'+ip+':9000/norva-admin',timeout=15)
 except urllib.error.HTTPError as error:
  if error.code not in (401,405):return False
 return True
phase=sys.argv[1]
if phase=='stage':
 assert not(ROOT/'deployment-plan.json').exists(),'Stage already exists'
 cs={s:inspect(n) for s,n in NAMES.items()}
 assert all(healthy(s) for s in NAMES),'Unhealthy baseline'
 sources={s:next(m['Source'] for m in cs[s]['Mounts'] if m['Destination']=='/home/deno/functions') for s in ['functions','functions2']}
 assert sources['functions']==sources['functions2'],'Replica source drift'
 source=pathlib.Path(sources['functions']);shutil.copytree(source,ROOT/'functions')
 relative='norva-admin/index.ts';live=(source/relative).read_text().replace('\r\n','\n')
 base=(ROOT/'candidate/norva-admin.base.ts').read_text().replace('\r\n','\n').splitlines(keepends=True)
 next_lines=(ROOT/'candidate/norva-admin.next.ts').read_text().replace('\r\n','\n').splitlines(keepends=True)
 candidate=live
 edits=[x for x in difflib.SequenceMatcher(None,base,next_lines,autojunk=False).get_opcodes() if x[0]!='equal']
 for _,i1,i2,j1,j2 in reversed(edits):
  lo=max(0,i1-3);hi=min(len(base),i2+3)
  old=''.join(base[lo:hi]);new=''.join(base[lo:i1]+next_lines[j1:j2]+base[i2:hi])
  assert candidate.count(old)==1,'Live anchor drift; refusing replacement'
  candidate=candidate.replace(old,new,1)
 (ROOT/'functions'/relative).write_text(candidate)
 helper='_shared/customer-service-health.ts'
 assert not(source/helper).exists(),'Helper already deployed'
 (ROOT/'functions'/helper).write_bytes((ROOT/'candidate/customer-service-health.ts').read_bytes().replace(b'\r\n',b'\n'))
 for path in (ROOT/'functions').rglob('*'):
  if path.is_file():path.chmod(0o644)
 changed={relative,helper}
 for path in source.rglob('*'):
  if path.is_file() and path.relative_to(source).as_posix() not in changed:
   assert digest(path)==digest(ROOT/'functions'/path.relative_to(source)),'Unrelated file drift'
 plan={'hashes':{r:digest(ROOT/'functions'/r) for r in changed},'services':{}}
 for service,c in cs.items():
  base_cmd=compose(c);before=json.loads(run(base_cmd+['config','--format','json']))
  # Recreate only from configuration that still matches the running environment.
  assert all(str(v)==env(c).get(k) for k,v in before['services'][service].get('environment',{}).items()),'Environment drift in '+service
  delta={'environment':FLAGS} if service=='auth' else {'volumes':[str(ROOT/'functions')+':/home/deno/functions:ro']}
  override=ROOT/(service+'-override.json');override.write_text(json.dumps({'services':{service:delta}}))
  next_cmd=base_cmd+['-f',str(override)]
  after=json.loads(run(next_cmd+['config','--format','json']))
  for key,value in before['services'].items():
   if key!=service:assert value==after['services'][key]
   else:
    allowed='environment' if service=='auth' else 'volumes'
    assert {k:v for k,v in value.items() if k!=allowed}=={k:v for k,v in after['services'][key].items() if k!=allowed}
  plan['services'][service]={'base':base_cmd,'next':next_cmd,'id':c['Id'],'image':c['Image']}
 (ROOT/'deployment-plan.json').write_text(json.dumps(plan))
 print(json.dumps({'staged':True,'unrelated_files_preserved':True,'hashes':plan['hashes']}))
elif phase in NAMES:
 plan=json.loads((ROOT/'deployment-plan.json').read_text());step=plan['services'][phase]
 assert json.loads((ROOT/'database-applied.json').read_text())['passed']
 before=inspect(NAMES[phase]);assert before['Id']==step['id'],'Container changed since stage'
 if phase!='auth':assert healthy('functions2' if phase=='functions' else 'functions'),'Other replica unavailable'
 for rel,sha in plan['hashes'].items():assert digest(ROOT/'functions'/rel)==sha
 try:
  run(step['next']+['up','-d','--no-deps','--no-build','--force-recreate',phase])
  after=inspect(NAMES[phase]);assert after['Image']==step['image']
  assert env(after)=={**env(before),**(FLAGS if phase=='auth' else {})},'Unrelated environment changed'
  ready=False
  for _ in range(15):
   try:ready=healthy(phase)
   except Exception:pass
   if ready:break
   time.sleep(1)
  assert ready,'Readiness failed'
  result={'service':phase,'healthy':True,'image_preserved':True,'unrelated_environment_preserved':True,'timestamp':time.time()}
  (ROOT/(phase+'-deployed.json')).write_text(json.dumps(result));print(json.dumps(result))
 except Exception:
  run(step['base']+['up','-d','--no-deps','--no-build','--force-recreate',phase])
  raise RuntimeError('Deployment failed; original service configuration restored. Inspect readiness.') from None
else:raise RuntimeError('Unknown phase')
