"""One-shot guarded rollout. Stage reviewed artifacts in the private audit dir.

Defaults to a plan. Does not send test messages or alter notification recipients.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess, time, urllib.request

args = argparse.ArgumentParser()
args.add_argument('--apply', action='store_true')
apply = args.parse_args().apply
root = pathlib.Path('/home/adrien/norva/ops/hetzner')
stage = pathlib.Path('/home/adrien/.norva/telegram-audit-20261002')
runtime = pathlib.Path('/home/adrien/.norva/phone-vod-recovery-20261001/release/edge-v2/functions')
expected = {'norva-admin/index.ts':'c8f79821bf7fc6b05e2bbca1704078837e5edf8a4b4dd95390891a0aff63fb20',
 '_shared/ops-notifications.ts':'44710d134b99f324f0f0f2384deb548c17d31af48bc6b9a0fe59dc9539e9db06'}
def run(cmd, data=None):
    return subprocess.run(cmd,input=data,text=True,capture_output=True,check=True).stdout
def inspect(name): return json.loads(run(['docker','inspect',name]))[0]
compose = ['docker','compose','--env-file',str(root/'.env'),'-f',str(root/'docker-compose.supabase.yml')]
def health(name):
    info=inspect(name)
    ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
    with urllib.request.urlopen('http://'+ip+':9000/norva-playback/health',timeout=8) as r:
        h=json.load(r)
    assert h.get('ok') and h.get('version')==84
for file,sha in expected.items():
    assert hashlib.sha256((runtime/file).read_text().encode()).hexdigest() in [sha,
      hashlib.sha256((stage/pathlib.Path(file).name).read_text().encode()).hexdigest()], file
env={}
for line in (root/'.env').read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k,v=line.split('=',1);env[k]=v.strip().strip('\"\'')
categories=['INFRASTRUCTURE','CATALOGUE','FINANCE','PARTNERS','SUPPORT','GROWTH']
assert env.get('TELEGRAM_CATEGORY_ROUTING_STRICT')=='1'
for c in categories:
    assert env.get('TELEGRAM_'+c+'_BOT_TOKEN') and env.get('TELEGRAM_'+c+'_CHAT_ID')
before={n:inspect(n) for n in ['norva-edge-functions','norva-edge-functions-2']}
for n in before: health(n)
print(json.dumps({'apply':apply,'routes':len(categories),'healthyReplicas':2}))
if not apply: raise SystemExit(0)
backup=stage/'deployment-before'
backup.mkdir(mode=0o700,exist_ok=True)
if not (backup/'compose.yml').exists(): shutil.copy2(root/'docker-compose.supabase.yml',backup/'compose.yml')
if not (backup/'edge-specs.json').exists():
    (backup/'edge-specs.json').write_text(json.dumps(before));(backup/'edge-specs.json').chmod(0o600)
for file in expected:
    target=runtime/file
    if not (backup/file.replace('/','_')).exists(): shutil.copy2(target,backup/file.replace('/','_'))
    target.write_text((stage/pathlib.Path(file).name).read_text())
for migration in ['20261002091000_ops_notification_recovery_hysteresis.sql','20261002091500_maintenance_retry_isolation.sql']:
    run(['docker','exec','-i','norva-db','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],(stage/migration).read_text())
path=root/'docker-compose.supabase.yml';text=path.read_text()
anchor='      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}'
assert text.count(anchor)==1 and 'TELEGRAM_CATEGORY_ROUTING_STRICT:' not in text
addition='\n      TELEGRAM_CATEGORY_ROUTING_STRICT: ${TELEGRAM_CATEGORY_ROUTING_STRICT:-0}'
for c in categories:
    for suffix in ['BOT_TOKEN','CHAT_ID']:
        key='TELEGRAM_'+c+'_'+suffix
        addition+='\n      '+key+': ${'+key+':-}'
text=text.replace(anchor,anchor+addition)
old='${NORVA_EDGE_FUNCTIONS_ROOT:-../../supabase/functions}:/home/deno/functions:ro'
assert text.count(old)==2
# Persist the currently running mount in the existing configuration variable.
env_path=root/'.env'
if not (backup/'stack.env').exists():
    shutil.copy2(env_path,backup/'stack.env');(backup/'stack.env').chmod(0o600)
env_lines=env_path.read_text().splitlines()
assert sum(l.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') for l in env_lines)==1
env_path.write_text('\n'.join('NORVA_EDGE_FUNCTIONS_ROOT='+str(runtime) if l.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') else l for l in env_lines)+'\n')
path.write_text(text)
configured=json.loads(run(compose+['config','--format','json']))
for name,service in [('norva-edge-functions','functions'),('norva-edge-functions-2','functions2')]:
    service_config=configured['services'][service]
    actual_env=dict(x.split('=',1) for x in before[name]['Config']['Env'])
    for key,value in service_config['environment'].items():
        if not key.startswith('TELEGRAM_'): assert str(value or '')==actual_env.get(key,''),key
    assert service_config['environment']['TELEGRAM_CATEGORY_ROUTING_STRICT']=='1'
    assert any(v.get('source')==str(runtime) and v['target']=='/home/deno/functions' for v in service_config['volumes'])
    run(compose+['up','-d','--no-deps','--force-recreate',service])
    for attempt in range(12):
        try: health(name);break
        except Exception:
            if attempt==11: raise
            time.sleep(2)
    current=inspect(name)
    assert current['Image']==before[name]['Image']
    current_env=dict(x.split('=',1) for x in current['Config']['Env'])
    assert all(current_env.get('TELEGRAM_'+c+'_BOT_TOKEN')==env['TELEGRAM_'+c+'_BOT_TOKEN'] for c in categories)
    print(name+' healthy; six dedicated routes verified')
sender=pathlib.Path('/home/adrien/norva-source-delete-cleanup-63310488/ops/hetzner/backup/telegram-send.py')
shutil.copy2(sender,backup/'telegram-send.py');shutil.copyfile(stage/'telegram-send.py',sender)
(stage/'deployment-receipt.json').write_text(json.dumps({'at':time.time(),'edgeHealthy':2,'routes':6,'strict':True,'runtime':str(runtime)}))
print('ROLLOUT_OK')
