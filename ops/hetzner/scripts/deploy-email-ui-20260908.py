"""Deploy only email presentation; preserve every other live file and all configuration."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,time,urllib.request
os.umask(0o077)
root=pathlib.Path(sys.argv[2]) if len(sys.argv)>2 else pathlib.Path('/home/adrien/.norva/email-ui-edge-20260908')
assert root.parent==pathlib.Path('/home/adrien/.norva') and root.name.startswith('email-ui-'), 'Unexpected release directory'
manifest=json.loads((root/'candidate'/'manifest.json').read_text())
expected={r:v['before']for r,v in manifest.items()}
flags={}
names=['norva-edge-functions','norva-edge-functions-2']
services=['functions','functions2']
def run(args):
 p=subprocess.run(args,capture_output=True,timeout=120)
 if p.returncode:raise RuntimeError('command failed: '+args[0])
 return p.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def digest(p):return hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()
def env(c):return dict(s.split('=',1)for s in c['Config']['Env']if '='in s)
def command(c):
 l=c['Config']['Labels'];a=['docker','compose','-p',l['com.docker.compose.project']]
 for f in l.get('com.docker.compose.project.environment_file','').split(','):
  if f:a+=['--env-file',f]
 for f in l['com.docker.compose.project.config_files'].split(','):a+=['-f',f]
 return a
def health(name):
 c=inspect(name);ip=c['NetworkSettings']['Networks']['norva_default']['IPAddress']
 for route in ['norva-playback','norva-lifecycle']:
  req=urllib.request.Request('http://'+ip+':9000/'+route+'/health',headers={'Authorization':'Bearer '+env(c).get('NORVA_BACKFILL_TOKEN','')})
  if json.load(urllib.request.urlopen(req,timeout=15)).get('ok')is not True:return False
 return True
phase=sys.argv[1]
if phase=='stage':
 assert not(root/'plan.json').exists(),'Plan already exists'
 cs=[inspect(n)for n in names]
 sources=[next(m['Source']for m in c['Mounts']if m['Destination']=='/home/deno/functions')for c in cs]
 assert sources[0]==sources[1],'Replica source drift'
 source=pathlib.Path(sources[0])
 for rel,sha in expected.items():
  assert (digest(source/rel)==sha if sha else not(source/rel).exists()),'Live source drift: '+rel
 for c in cs:
  for flag in ['NORVA_LC_EXPIRE','NORVA_LC_WINBACK','NORVA_LC_ABANDONED']:
   assert env(c).get(flag,'false').lower()not in ['true','1','yes'],'Unexpected unrelated activation'
 assert all(health(n)for n in names),'Unhealthy baseline'
 shutil.copytree(source,root/'functions')
 for rel in expected:
  p=root/'functions'/rel;p.write_bytes((root/'candidate'/rel).read_bytes().replace(b'\r\n',b'\n'));p.chmod(0o644)
 for rel in expected:assert digest(root/'functions'/rel)==manifest[rel]['after'],'Candidate hash mismatch'
 for p in source.rglob('*'):
  if p.is_file()and str(p.relative_to(source))not in expected:assert digest(p)==digest(root/'functions'/p.relative_to(source))
 override=root/'override.json'
 override.write_text(json.dumps({'services':{s:{'volumes':[str(root/'functions')+':/home/deno/functions:ro'],'environment':flags}for s in services}}))
 base=command(cs[0]);before=json.loads(run(base+['config','--format','json']));after=json.loads(run(base+['-f',str(override),'config','--format','json']))
 for s,a in before['services'].items():
  b=after['services'][s]
  if s not in services:assert a==b
  else:
   assert {k:v for k,v in a.items()if k not in ['volumes','environment']}=={k:v for k,v in b.items()if k not in ['volumes','environment']}
   assert [v for v in a['volumes']if v['target']!='/home/deno/functions']==[v for v in b['volumes']if v['target']!='/home/deno/functions']
   assert {**a['environment'],**flags}==b['environment']
 plan={'base':base,'next':base+['-f',str(override)],'old':sources[0],'ids':{c['Name'].lstrip('/'):c['Id']for c in cs},'hashes':{r:digest(root/'functions'/r)for r in expected}}
 (root/'plan.json').write_text(json.dumps(plan));print(json.dumps({'staged':True,'unrelatedFilesPreserved':True,'flags':flags,'hashes':plan['hashes']}))
elif phase in services:
 plan=json.loads((root/'plan.json').read_text());i=services.index(phase);name=names[i];before=inspect(name)
 assert before['Id']==plan['ids'][name],'Container changed after staging'
 assert health(names[1-i]),'Other replica unavailable'
 for rel,sha in plan['hashes'].items():assert digest(root/'functions'/rel)==sha
 try:
  run(plan['next']+['up','-d','--no-deps','--no-build','--force-recreate',phase])
  after=inspect(name);assert after['Image']==before['Image'];assert env(after)=={**env(before),**flags}
  ok=False
  for _ in range(15):
   try:ok=health(name)
   except Exception:pass
   if ok:break
   time.sleep(1)
  assert ok,'Readiness failed'
  for rel,sha in plan['hashes'].items():assert hashlib.sha256(run(['docker','exec',name,'cat','/home/deno/functions/'+rel]).replace(b'\r\n',b'\n')).hexdigest()==sha
  print(json.dumps({'deployed':name,'healthy':True,'hashesVerified':True,'configurationUnchanged':True}))
 except Exception:
  run(plan['base']+['up','-d','--no-deps','--no-build','--force-recreate',phase])
  raise RuntimeError('Rollout failed; old compose restored; verify readiness')from None
else:raise RuntimeError('Unknown phase')
