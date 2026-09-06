import hashlib,json,os,secrets,socket,subprocess,sys
from pathlib import Path
SOURCE=Path(__file__).resolve().parent;ROOT=Path('/home/adrien/.norva/postal-full-service-v1')
NAME='norva-private-mail-v1';IMAGE='norva-private-mail:20260906-v2'
BASE='sha256:ffe7000cbe982ce41418fd00f7310df4ab08be1f5d84b3c8416b76868651f736'
def run(args,data=None,timeout=60):
 r=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if r.returncode:raise RuntimeError('command_failed_'+args[0])
 return r.stdout
def sql(text):return run(['docker','exec','-i','norva-db','psql','-X','-At','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],text.encode())
def save(p,v):
 with p.open('x')as f:os.chmod(p,0o600);json.dump(v,f);f.flush();os.fsync(f.fileno())
def manifest():
 m=json.loads((SOURCE/'manifest.json').read_text())
 for n,h in m.items():assert (SOURCE/n).resolve().is_relative_to(SOURCE) and hashlib.sha256((SOURCE/n).read_bytes()).hexdigest()==h
 return m
def prepare():
 m=manifest();assert not ROOT.exists();old=json.loads(Path('/home/adrien/.norva/postal-auth-service-v1/private/config.json').read_text())
 assert not old.get('enabled') and not old.get('expiresUnix')
 assert sql("select to_regnamespace('norva_postal_full') is null").strip()==b't'
 for p in [ROOT,ROOT/'private',ROOT/'data',ROOT/'bridge']:p.mkdir(mode=0o700)
 run(['ssh-keygen','-q','-t','ed25519','-N','','-C','norva-private-full-mail-v1','-f',str(ROOT/'private/runner.key')])
 c={'enabled':False,'dailyLimit':1000,'activeLimit':500,'storeKey':secrets.token_hex(32),'wireKey':secrets.token_hex(32),
  'database':{'host':'127.0.0.1','port':5432,'user':'norva_postal_full_worker','password':secrets.token_hex(32),'database':'postgres'},
  'sshHostSha256':old['sshHostSha256'],'postalPublicJwk':old['postalPublicJwk']}
 save(ROOT/'private/config.json',c);save(ROOT/'prepared.json',{'manifest':m,'source':str(SOURCE)})
 print(json.dumps({'result':'FULL_HOST_PREPARED_DISABLED','publicKeyPath':str(ROOT/'private/runner.key.pub'),'emailSent':False}))

def refresh():
 m=manifest();c=json.loads((ROOT/'private/config.json').read_text())
 assert not c['enabled'] and not (ROOT/'installed.json').exists()
 assert sql("select to_regnamespace('norva_postal_full') is null").strip()==b't'
 names=run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines();assert NAME not in names
 old=ROOT/'prepared.json';backup=ROOT/('prepared.'+hashlib.sha256(old.read_bytes()).hexdigest()[:12]+'.before.json')
 if not backup.exists():save(backup,json.loads(old.read_text()))
 tmp=ROOT/'prepared.json.next';save(tmp,{'manifest':m,'source':str(SOURCE)});os.replace(tmp,old)
 print(json.dumps({'result':'FULL_HOST_PACKAGE_REFRESHED_DISABLED','keysPreserved':True,'emailSent':False}))
def install():
 m=manifest();c=json.loads((ROOT/'private/config.json').read_text());assert not c['enabled'] and not (ROOT/'installed.json').exists()
 assert json.loads((ROOT/'prepared.json').read_text())['manifest']==m
 with socket.socket()as probe:probe.bind(('172.18.0.1',18185))
 assert json.loads(run(['docker','image','inspect',BASE]))[0]['Id']==BASE
 assert json.loads(run(['docker','image','inspect','norva-postal-branded-reviewed-base:20260906']))[0]['Id']==BASE
 run(['docker','build','--pull=false','--network','none','-t',IMAGE,str(SOURCE)],timeout=120)
 sql("set norva.postal_install='full-v1-disabled';\n"+(SOURCE/'migration.sql').read_text())
 password=c['database']['password'];assert len(password)==64 and set(password)<=set('0123456789abcdef')
 sql("alter role norva_postal_full_worker login password '"+password+"';")
 edge=json.loads(run(['docker','inspect','norva-edge-functions']))[0]
 env=dict(x.split('=',1) for x in edge['Config']['Env'] if '=' in x)
 ops=env.get('NORVA_OPS_EMAIL','').strip().lower()
 if ops:
  import re
  assert re.fullmatch(r'[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}',ops)
  sql("update norva_postal_full.policy set ops_recipients=array['"+ops+"'];")
 run(['docker','run','-d','--name',NAME,'--label','norva.owner=postal-full-v1','--network','host','--read-only',
  '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','.35','--pids-limit','64',
  '--stop-timeout','160','--restart','unless-stopped','--log-opt','max-size=1m','--log-opt','max-file=2',
  '--mount','type=bind,src='+str(ROOT/'private')+',dst=/private,readonly','--mount','type=bind,src='+str(ROOT/'data')+',dst=/data',
  '--mount','type=bind,src='+str(ROOT/'bridge')+',dst=/bridge',IMAGE])
 run(['docker','run','-d','--name','norva-private-mail-gateway','--label','norva.owner=postal-full-v1','--network','norva_default',
  '--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','96m','--cpus','.1','--pids-limit','48',
  '--restart','unless-stopped','--log-opt','max-size=1m','--log-opt','max-file=2',
  '--mount','type=bind,src='+str(ROOT/'bridge')+',dst=/bridge,readonly',IMAGE,'node','/app/gateway.mjs'])
 save(ROOT/'installed.json',{'manifest':m,'image':json.loads(run(['docker','image','inspect',IMAGE]))[0]['Id'],'enabled':False})
 print(json.dumps({'result':'FULL_PRIVATE_SERVICE_INSTALLED_DISABLED','emailSent':False}))
if __name__=='__main__':
 os.umask(0o077)
 try:
  assert os.geteuid()==1000 and socket.gethostname()=='norva-db'
  assert len(sys.argv)==2
  {'--prepare-disabled':prepare,'--refresh-uninstalled':refresh,'--install-disabled':install}[sys.argv[1]]()
 except Exception as e:print(json.dumps({'result':'FULL_HOST_INSTALL_REFUSED','errorClass':type(e).__name__,'detailsSuppressed':True}));sys.exit(1)
