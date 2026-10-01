"""Apply only the reviewed Selection delta; retain old containers for rollback."""
import datetime, hashlib, http.client, json, os, pathlib, socket, subprocess, sys, time, urllib.request
ROOT=pathlib.Path('/home/adrien/.norva/selection-startup-20261001')
EDGE=pathlib.Path('/home/adrien/.norva/owned-language-edge-rollout-20260928/functions')
BASE='sha256:41db368fba067ba6d83001983edb4f5128bef76ecbcd63966137b2cc9a9aa649'
CLOUD_BEFORE='a389589e69b769b454e360133c8fc705b08628e3b1a9c2ba0893fa89f055efb0'
GATEWAY_BEFORE='3aa194474cf181999591e7e42f64393f763aec159c031971cd118d61923a2df0'
def run(*args): return subprocess.check_output(args)
def inspect(name): return json.loads(run('docker','inspect',name))[0]
def sha(data): return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def save(path,data):
    path.write_bytes(data); os.chmod(path,0o600)
def health(port):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=5) as response: return json.load(response)
def idle(port):
    value=health(port)
    for key in ['activeSessions','rawPumpCount','viewerSessionStartupAdmissions','viewerSessionStartupWaiters',
                'playbackPreparationPendingCount','activeStrictLidBrokers','whisperInferenceActive',
                'activeViewerSubtitleOperations']:
        assert value.get(key)==0, 'Gateway busy: '+key
def sql(text):
    result=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1',
        '-U','supabase_admin','-d','postgres'],input=text,text=True,capture_output=True,timeout=45)
    assert result.returncode==0,result.stderr[-800:]
    return result.stdout.strip()
class DockerConnection(http.client.HTTPConnection):
    def __init__(self): super().__init__('localhost')
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); self.sock.connect('/var/run/docker.sock')
def docker_post(path,payload):
    connection=DockerConnection(); connection.request('POST','/v1.47'+path,json.dumps(payload),{'Content-Type':'application/json'})
    response=connection.getresponse(); data=response.read(); connection.close()
    assert response.status<300,'Docker API status '+str(response.status)
    return json.loads(data) if data else {}
def replace_gateway(name,port,image):
    old=inspect(name); assert old['Image']==BASE,'Image drift'
    assert sha(run('docker','exec',name,'cat','/app/src/index.js'))==GATEWAY_BEFORE,'Source drift'
    idle(port)
    save(ROOT/(name+'.before.private.json'),json.dumps(old).encode())
    config=dict(old['Config']); config['Image']=image
    config['HostConfig']=old['HostConfig']
    config['NetworkingConfig']={'EndpointsConfig':{network:{'Aliases':[name]} for network in old['NetworkSettings']['Networks']}}
    backup=name+'-before-selection-'+BASE[7:19]
    run('docker','rename',name,backup)
    created=False
    try:
        docker_post('/containers/create?name='+name,config); created=True
        idle(port); run('docker','stop','-t','30',backup); run('docker','start',name)
        for attempt in range(30):
            try:
                health(port); break
            except Exception:
                if attempt==29: raise
                time.sleep(1)
        current=inspect(name)
        assert current['Image']==image and current['Config']['Env']==old['Config']['Env']
        for key in ['Binds','PortBindings','Devices','RestartPolicy','Memory','NanoCpus','NetworkMode']:
            assert current['HostConfig'].get(key)==old['HostConfig'].get(key),'Configuration drift: '+key
        assert sha(run('docker','exec',name,'cat','/app/src/index.js'))==sha((ROOT/'services/media-gateway/src/index.js').read_bytes())
        save(ROOT/(name+'.applied.safe.json'),json.dumps({'image':image,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}).encode())
        print(json.dumps({'gateway':name,'applied':True,'image':image}),flush=True)
    except Exception:
        # Never stop a newly active viewer merely to undo this deployment.
        if created:
            try: idle(port)
            except Exception:
                if inspect(name)['State']['Running']: raise
            run('docker','rm','-f',name)
        run('docker','rename',backup,name); run('docker','start',name)
        raise
def apply_edge():
    target=EDGE/'norva-cloud/index.ts'; helper=EDGE/'_shared/selection-prepared-catalog.mjs'
    assert sha(target.read_bytes())==CLOUD_BEFORE and not helper.exists(),'Edge drift'
    for port in [8081,18086]: idle(port)
    migration=(ROOT/'supabase/migrations/20261001090000_selection_prepared_catalog.sql').read_text()
    acl="select has_table_privilege('authenticated','public.selection_prepared_catalogs','select') or has_table_privilege('anon','public.selection_prepared_catalogs','select');"
    assert sql(migration.replace('commit;',acl+'rollback;'))=='f','Public template ACL failed'
    sql(migration+"\nnotify pgrst, 'reload schema';")
    save(ROOT/'cloud.before.ts',target.read_bytes())
    target.write_bytes((ROOT/'supabase/functions/norva-cloud/index.ts').read_bytes())
    helper.write_bytes((ROOT/'supabase/functions/_shared/selection-prepared-catalog.mjs').read_bytes())
    for name in ['norva-edge-functions','norva-edge-functions-2']:
        run('docker','restart',name)
        assert inspect(name)['State']['Running']
        assert sha(run('docker','exec',name,'cat','/home/deno/functions/norva-cloud/index.ts'))==sha(target.read_bytes())
    print(json.dumps({'edgeApplied':True,'publicReadDenied':sql(acl)=='f'}),flush=True)
if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='edge': apply_edge()
    elif mode in ('main','pilot'):
        image=json.loads((ROOT/'image.safe.json').read_text())['image']
        replace_gateway(*(('norva-media-gateway',8081) if mode=='main' else ('norva-resume-cache-pilot-20260916',18086)),image)
    else: raise ValueError('Expected edge, main or pilot')
