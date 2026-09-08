"""Scoped private worker and independent monitor rollout; preserve the running image for rollback."""
import hashlib,json,os,pathlib,subprocess,sys,time,urllib.request
os.umask(0o077)
ROOT=pathlib.Path('/home/adrien/.norva/email-reliability-20260908')
NAME='norva-private-mail-v1'
def run(args,timeout=60):
 r=subprocess.run(args,capture_output=True,timeout=timeout)
 if r.returncode:raise RuntimeError('command_failed_'+args[0])
 return r.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def health():return json.load(urllib.request.urlopen('http://172.18.0.1:18185/health',timeout=5))
phase=sys.argv[1]
if phase=='stage':
 c=inspect(NAME);assert c['HostConfig']['NetworkMode']=='host' and c['HostConfig']['ReadonlyRootfs']
 before={n:hashlib.sha256(run(['docker','exec',NAME,'cat','/app/'+n])).hexdigest() for n in ['model.mjs','worker.mjs']}
 assert health()['enabled']
 if (ROOT/'before.json').exists():assert json.loads((ROOT/'before.json').read_text())['container']['Id']==c['Id']
 else:(ROOT/'before.json').write_text(json.dumps({'container':c,'hashes':before}))
 run(['docker','tag',c['Image'],'norva-private-mail:reliability-base-20260908'])
 (ROOT/'Dockerfile').write_text('FROM norva-private-mail:reliability-base-20260908\nCOPY model.mjs worker.mjs delivery-monitor.mjs /app/\n')
 run(['docker','build','--pull=false','--network','none','-t','norva-private-mail:reliability-20260908',str(ROOT)],120)
 print(json.dumps({'staged':True,'before':before}))
elif phase=='worker':
 saved=json.loads((ROOT/'before.json').read_text());c=inspect(NAME);assert c['Id']==saved['container']['Id']
 run(['docker','image','inspect','norva-private-mail:reliability-20260908'])
 assert not any(x['state']in ['sending','api_started','uncertain'] and x['count'] for x in health()['counts'])
 run(['docker','stop','--time','160',NAME],180)
 old=NAME+'-before-20260908';run(['docker','rename',NAME,old])
 try:
  args=['docker','run','-d','--name',NAME,'--label','norva.owner=postal-full-v1','--network','host','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','.35','--pids-limit','64','--stop-timeout','160','--restart','unless-stopped','--log-opt','max-size=1m','--log-opt','max-file=2']
  for m in c['Mounts']:args+=['--mount','type=bind,src='+m['Source']+',dst='+m['Destination']+(',readonly' if not m['RW'] else '')]
  run(args+['norva-private-mail:reliability-20260908'])
  for _ in range(30):
   try:
    if health()['guestVerified']:break
   except Exception:pass
   time.sleep(1)
  assert health()['guestVerified']
  print(json.dumps({'deployed':NAME,'healthy':True,'rollbackContainer':old}))
 except Exception:
  run(['docker','rm','-f',NAME]);run(['docker','rename',old,NAME]);run(['docker','start',NAME]);raise
elif phase=='monitor':
 p=ROOT/'monitor-private';p.mkdir(mode=0o700,exist_ok=True);d=ROOT/'monitor-data';d.mkdir(mode=0o700,exist_ok=True)
 env=dict(x.split('=',1)for x in inspect('norva-edge-functions')['Config']['Env'])
 token=env.get('TELEGRAM_INFRASTRUCTURE_BOT_TOKEN');chat=env.get('TELEGRAM_INFRASTRUCTURE_CHAT_ID');assert token and chat
 cfg=json.loads(pathlib.Path('/home/adrien/.norva/postal-full-service-v1/private/config.json').read_text())
 (p/'config.json').write_text(json.dumps({'database':cfg['database'],'telegramToken':token,'telegramChat':chat}))
 run(['docker','run','-d','--name','norva-mail-delivery-monitor','--label','norva.owner=email-reliability-20260908','--network','host','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','.1','--pids-limit','48','--restart','unless-stopped','--log-opt','max-size=1m','--log-opt','max-file=2','--mount','type=bind,src='+str(p)+',dst=/private,readonly','--mount','type=bind,src='+str(d)+',dst=/data','norva-private-mail:reliability-20260908','node','/app/delivery-monitor.mjs'])
 print(json.dumps({'monitorStarted':True,'channel':'existing_infrastructure_telegram'}))
else:raise RuntimeError('unknown_phase')
