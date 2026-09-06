"""Scoped dormant SQL + one-file private Postal image overlay; no sends/activation.

Copy this script, cadence.sql and store.mjs into ROOT. Run --prepare, inspect its
proof, then --install. A repeated/ambiguous install refuses automatic replay.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/home/adrien/.norva/lifecycle-email-cadence-20260906-r1')
SERVICE = Path('/home/adrien/.norva/postal-full-service-v1')
NAME = 'norva-private-mail-v1'
OLD = 'norva-private-mail-before-cadence-20260906'
CANDIDATE = 'norva-private-mail-cadence-candidate-20260906'
BASE = 'sha256:277f32f0ccea6d031f82f96473ff978c3cc214d9fa35a12eeac671163483c749'
BASE_TAG = 'norva-private-mail:20260906-v2'
IMAGE = 'norva-private-mail:20260906-cadence-v1'
SQL_SHA = '97909019e85a8352ed05563b97d043d3c35c9e21af38e058abc420c640fe7cf5'
STORE_SHA = '4e2ecfa7c82f2c5e296afa915348378f1718cb893ee35f0357bf53a1d06480a4'
BASE_STORE_SHA = '7b685c4c41c4f36e3e7d1953148ae6a4f297d2536762715df511180f3cc42b5d'
SIGNATURES = [
 'public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)',
 'public.norva_authorize_behavioral_email_enqueue(uuid,uuid)',
 'public.authorize_branded_email_delivery(uuid,text,uuid)',
 'norva_postal_full.eligibility(text,text,boolean,text)',
 'public.claim_postal_branded_email_deliveries(integer,integer,integer)',
 'public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer)',
 'public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean)',
]
OID_LIST = ','.join("'" + s + "'::regprocedure" for s in SIGNATURES)
SNAPSHOT = """select jsonb_object_agg(oid::regprocedure::text,jsonb_build_object(
 'md5',md5(replace(prosrc,chr(13),'')),'owner',pg_get_userbyid(proowner),
 'acl',proacl,'config',proconfig)) from pg_proc where oid in (""" + OID_LIST + ');'
GATE = """select jsonb_build_object('stopped',
 exists(select 1 from public.behavioral_lifecycle_runtime where emergency_stop and audience_mode='internal_test')
 and (select count(*) from public.behavioral_lifecycle_journeys)=4
 and not exists(select 1 from public.behavioral_lifecycle_journeys where status<>'draft' or rollout_percent<>0 or activated_at is not null)
 and not exists(select 1 from public.behavioral_lifecycle_outbox),
 'delay',(select delay_minutes from public.behavioral_lifecycle_steps where journey_key='no_source' and step_key='day_three_email'),
 'installed',to_regprocedure('norva_postal_full.behavioral_email_not_before(uuid,timestamptz)') is not null);"""


def run(args, data=None, timeout=45):
    r = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError('command_failed:' + args[0])
    return r.stdout


def sql(query):
    return run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-At', '-q',
                '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'], query.encode()).decode().strip()


def save(name, data):
    with (ROOT / name).open('x') as f:
        f.write(data if isinstance(data, str) else json.dumps(data, indent=2))
        f.flush()
        os.fsync(f.fileno())


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def health():
    return json.load(urllib.request.urlopen('http://172.18.0.1:18185/health', timeout=4))


def payload():
    data = (ROOT / 'cadence.sql').read_bytes().replace(b'\r\n', b'\n')
    assert hashlib.sha256(data).hexdigest() == SQL_SHA
    return data.decode()


def same_runtime(previous, current):
    for key in ['NetworkMode','ReadonlyRootfs','Memory','NanoCpus','PidsLimit','CapDrop','SecurityOpt','LogConfig','RestartPolicy']:
        assert current['HostConfig'][key] == previous['HostConfig'][key], 'Unrelated container setting changed: ' + key
    for key in ['Env','Cmd','Entrypoint','User','WorkingDir','StopTimeout']:
        assert current['Config'].get(key) == previous['Config'].get(key), 'Unrelated process setting changed: ' + key
    assert {(m['Source'],m['Destination'],m['RW']) for m in current['Mounts']} == {
        (m['Source'],m['Destination'],m['RW']) for m in previous['Mounts']}


def prepare(resume=False):
    assert not (ROOT / 'ready.json').exists() and not (ROOT / 'install.started.json').exists()
    assert (ROOT / 'functions.before.sql').exists() == resume
    gate = json.loads(sql(GATE))
    assert gate == {'stopped': True, 'delay': 4320, 'installed': False}
    current = inspect(NAME)
    assert current['State']['Running'] and current['Image'] == BASE
    assert current['HostConfig']['NetworkMode'] == 'host' and current['Config']['User'] == '1000:1000'
    assert current['HostConfig']['ReadonlyRootfs'] and current['HostConfig']['RestartPolicy']['Name'] == 'unless-stopped'
    expected_mounts = {(str(SERVICE / p), '/' + p, p != 'private') for p in ['private', 'data', 'bridge']}
    assert {(m['Source'],m['Destination'],m['RW']) for m in current['Mounts']} == expected_mounts
    old_store = run(['docker', 'exec', NAME, 'cat', '/app/store.mjs'])
    assert hashlib.sha256(old_store).hexdigest() == BASE_STORE_SHA
    source = (ROOT / 'store.mjs').read_bytes().replace(b'\r\n', b'\n')
    assert hashlib.sha256(source).hexdigest() == STORE_SHA
    (ROOT / 'store.mjs').write_bytes(source)
    before = json.loads(sql(SNAPSHOT))
    definitions = sql('select pg_get_functiondef(oid) from pg_proc where oid in (' + OID_LIST + ');')
    backup_sql = 'BEGIN;\n' + definitions + '\nCOMMIT;\n'
    if resume:
        assert (ROOT / 'functions.before.sql').read_text() == backup_sql
        assert json.loads((ROOT / 'database.before.json').read_text()) == before
        assert json.loads((ROOT / 'container.before.json').read_text())['Id'] == current['Id']
    else:
        save('functions.before.sql', backup_sql)
        save('container.before.json', current)
        save('database.before.json', before)
    # Roll back the exact DDL against the actual production baseline first.
    candidate = payload()
    assert candidate.rstrip().endswith('commit;')
    dry = candidate.rstrip()[:-len('commit;')] + SNAPSHOT + '\nROLLBACK;'
    after = json.loads(sql(dry))
    assert json.loads(sql(SNAPSHOT)) == before and json.loads(sql(GATE)) == gate
    for key in before:
        assert {k:v for k,v in after[key].items() if k!='md5'} == {k:v for k,v in before[key].items() if k!='md5'}
    # The derivative image changes only /app/store.mjs, never credentials/data.
    dockerignore = '*\n!Dockerfile\n!store.mjs\n'
    suffix = '\nCOPY --chown=1000:1000 store.mjs /app/store.mjs\n'
    dockerfile = 'FROM ' + BASE_TAG + suffix
    # BuildKit treats a raw image ID in FROM as a remote repository name.
    # Use the already-present local tag, pin its ID before/after the build and
    # verify the complete inherited layer chain below. Never pull a new base.
    assert inspect(BASE_TAG)['Id'] == BASE
    if resume:
        assert (ROOT / '.dockerignore').read_text() == dockerignore
        assert (ROOT / 'Dockerfile').read_text() in ('FROM ' + BASE + suffix, dockerfile)
        (ROOT / 'Dockerfile').write_text(dockerfile)
    else:
        save('.dockerignore', dockerignore)
        save('Dockerfile', dockerfile)
    run(['docker', 'build', '--pull=false', '--network', 'none', '-t', IMAGE, str(ROOT)], timeout=60)
    assert inspect(BASE_TAG)['Id'] == BASE
    built, base = inspect(IMAGE), inspect(BASE)
    assert built['RootFS']['Layers'][:-1] == base['RootFS']['Layers']
    for key in ['Env','Cmd','Entrypoint','User','WorkingDir']:
        assert built['Config'].get(key) == base['Config'].get(key)
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
         '--memory', '128m', '--entrypoint', 'node', IMAGE, '--check', '/app/store.mjs'])
    save('ready.json', {'baseImage':BASE,'image':built['Id'],'sqlSha':SQL_SHA,'storeSha':STORE_SHA,
                       'before':before,'after':after,'rolledBackProductionDDL':True})
    print(json.dumps({'prepared':True,'image':built['Id'],'productionDdlRolledBack':True,
                      'runtimeRestarted':False,'customerJourneysActivated':False}))


def install():
    ready = json.loads((ROOT / 'ready.json').read_text())
    assert not (ROOT / 'install.started.json').exists(), 'Inspect the previous attempt; do not replay'
    assert ready['sqlSha']==SQL_SHA and ready['storeSha']==STORE_SHA
    assert json.loads(sql(SNAPSHOT))==ready['before']
    assert json.loads(sql(GATE))=={'stopped':True,'delay':4320,'installed':False}
    assert inspect(NAME)['Image']==BASE and inspect(IMAGE)['Id']==ready['image']
    names=run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    assert OLD not in names and CANDIDATE not in names
    previous=inspect(NAME)
    # A 1.5s health/receipt tick also sets busy with an empty queue. Wait for a
    # genuinely idle boundary, without weakening any health or queue condition.
    for attempt in range(20):
        h=health()
        assert h['enabled'] and h['guestVerified'] and h['lastFault'] is None
        if not h['busy']: break
        time.sleep(.5)
    else: raise RuntimeError('Private worker did not become idle; nothing replaced')
    assert not any(c['state'] in ['pending','api_started','held','sending'] and c['count'] for c in h['counts'])
    # Validate the complete replacement configuration before stopping service.
    # This candidate is created stopped: no listener, scheduler or mail action.
    run(['docker','create','--name',CANDIDATE,'--label','norva.owner=postal-full-v1',
         '--network','host','--read-only','--user','1000:1000','--cap-drop','ALL',
         '--security-opt','no-new-privileges','--memory','256m','--cpus','.35',
         '--pids-limit','64','--stop-timeout','160','--restart','unless-stopped',
         '--log-opt','max-size=1m','--log-opt','max-file=2',
         '--mount','type=bind,src='+str(SERVICE/'private')+',dst=/private,readonly',
         '--mount','type=bind,src='+str(SERVICE/'data')+',dst=/data',
         '--mount','type=bind,src='+str(SERVICE/'bridge')+',dst=/bridge',ready['image']])
    same_runtime(previous,inspect(CANDIDATE))
    save('install.started.json',{'at':time.time(),'oneShot':True,'noOperatorSend':True})
    run(['docker','update','--restart=no',NAME])
    run(['docker','stop','--time','160',NAME],timeout=175)
    assert not inspect(NAME)['State']['Running']
    run(['docker','rename',NAME,OLD])
    run(['docker','rename',CANDIDATE,NAME])
    run(['docker','start',NAME])
    same_runtime(previous,inspect(NAME))
    for attempt in range(25):
        try:
            h=health()
            if h['guestVerified'] and h['enabled'] and h['lastFault'] is None: break
        except (OSError,ValueError): pass
        time.sleep(1)
    else: raise RuntimeError('New private worker unhealthy; old container preserved stopped')
    assert hashlib.sha256(run(['docker','exec',NAME,'cat','/app/store.mjs'])).hexdigest()==STORE_SHA
    sql(payload())
    assert json.loads(sql(SNAPSHOT))==ready['after']
    assert json.loads(sql(GATE))=={'stopped':True,'delay':1440,'installed':True}
    sql("notify pgrst,'reload schema';")
    save('installed.json',{'at':time.time(),'image':ready['image'],'sqlSha':SQL_SHA,'storeSha':STORE_SHA,
                           'oldContainer':OLD,'journeysStopped':True,'operatorEmails':0})
    print(json.dumps({'installed':True,'image':ready['image'],'privateWorkerHealthy':True,
                      'cadenceEarliestHours':24,'usablePushHours':72,'journeysActivated':False,'operatorEmails':0}))


if __name__ == '__main__':
    os.umask(0o077)
    assert socket.gethostname()=='norva-db' and os.geteuid()==1000
    assert Path(__file__).resolve().parent==ROOT and ROOT.resolve()==ROOT
    assert len(sys.argv)==2
    {'--prepare':prepare,'--resume-prepare':lambda:prepare(resume=True),'--install':install}[sys.argv[1]]()
