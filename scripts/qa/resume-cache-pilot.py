"""Bounded pilot gateway; never restarts the main gateway or touches its queues."""
import json, os, pathlib, subprocess, sys, time, urllib.request, uuid, re
os.umask(0o077)
ROOT = pathlib.Path('/home/adrien/.norva/resume-cache-pilot-20260916')
NAME = 'norva-resume-cache-pilot-20260916'
IMAGE = 'norva-media-gateway:resume-maintenance-candidate-20260916'
BASE = 'sha256:ecced97ceea8742a778e134a51c4593badeac2f9933e403e910f7837f24d280e'
PREFIX = '/resume-cache-pilot-20260916'
KEYS = ['NORVA_MEDIA_GATEWAY_CANARY_' + s for s in ('URL', 'TOKEN', 'ID', 'USER_HASHES')]
def run(args, **kw): return subprocess.check_output(args, **kw).decode().strip()
def sql(q): return run(['docker','exec','-i','norva-db','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-At'], input=q.encode())
def quote(s): return "'" + str(s).replace("'", "''") + "'"
def config(): return json.loads(sql("select json_object_agg(key,value) from public.cloud_runtime_config where key like 'NORVA_MEDIA_GATEWAY_CANARY_%';"))
def inspect(name): return json.loads(run(['docker','inspect',name]))[0]
def request(url, body=None, method=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type':'application/json'}, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read()
        return json.loads(body) if body else None
def save(name, value):
    with (ROOT/name).open('x') as f: json.dump(value, f)
def state(): return json.loads((ROOT/'state.private.json').read_text())
def emit(v): print(json.dumps(v), flush=True)
def stage():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    assert not (ROOT/'state.private.json').exists(), 'already_staged'
    old=config(); assert old[KEYS[3]] == '', 'foreign_pilot_active'
    live=inspect('norva-media-gateway'); assert live['Image']==BASE, 'live_image_changed'
    e=dict(x.split('=',1) for x in live['Config']['Env'])
    owner=e.get('PRIVATE_RESUME_CACHE_OWNER_HASHES','').strip()
    assert len(owner)==64 and all(c in '0123456789abcdef' for c in owner), 'ambiguous_owner_scope'
    assert e.get('PRIVATE_RESUME_CACHE_ENABLED')=='true', 'pilot_not_enabled'
    assert e.get('GATEWAY_TOKEN')==old[KEYS[1]], 'token_mismatch'
    e.update(PUBLIC_BASE_URL='https://media.norva.tv'+PREFIX, OUTPUT_DIR='/tmp/resume-pilot',
        MKV_COMPLETE_HLS_CACHE_ROOT='/tmp/resume-pilot/cache-v2', MKV_H264_HLS_CACHE_DIR='/tmp/resume-pilot/cache-v1',
        MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_ENABLED='false', STORYBOARD_PRIVATE_DIR='',
        LANGUAGE_CAPTURE_PRIVATE_DIR='/tmp/resume-pilot/capture', LANGUAGE_PASSIVE_CAPTURE_ENABLED='0',
        PROVIDER_ROUTE_BENCHMARK_ENABLED='false', GATEWAY_MAINTENANCE_ENABLED='true')
    with (ROOT/'gateway.env').open('x') as f:
        for k,v in e.items():
            assert '\n' not in v
            f.write(k+'='+v+'\n')
    gid=str(uuid.uuid4())
    values=dict(zip(KEYS, ['http://'+NAME+':8080', old[KEYS[1]], gid, owner]))
    save('state.private.json', {'old':old,'values':values,'gid':gid,'mainId':live['Id'],
        'mainImage':live['Image'],'at':time.time()})
    host=live['HostConfig']; nano=host.get('NanoCpus') or 1000000000; memory=host.get('Memory') or 2147483648
    cmd=['docker','run','-d','--name',NAME,'--network','norva_default','--user',live['Config']['User'] or '1000:1000',
        '--group-add','993','--device','/dev/dri/renderD128','--cpus',str(nano/1000000000),'--memory',str(memory),
        '--cap-drop','ALL','--security-opt','no-new-privileges','--init',
        '--tmpfs','/tmp/resume-pilot:rw,size=2g,uid=1000,gid=1000,mode=0700',
        '-p','127.0.0.1:18086:8080','--env-file',str(ROOT/'gateway.env'),IMAGE]+live['Config']['Cmd']
    run(cmd)
    emit({'staged':True,'mainUnchanged':inspect('norva-media-gateway')['Id']==live['Id'],'routingChanged':False})
def activate():
    s=state(); assert config()==s['old'], 'route_changed'
    assert inspect('norva-media-gateway')['Id']==s['mainId'], 'main_changed'
    h=request('http://127.0.0.1:18086/health')
    assert h['ok'] and h['activeSessions']==0 and h['transcribeQueueDepth']==0, 'candidate_not_idle'
    assert h['privateResumeHlsCache']['enabled'] and h['privateResumeHlsCache']['ownerScoped'], 'cache_not_scoped'
    path='/config/apps/http/servers/srv0/routes/1/handle/0/routes/0/handle/0/routes'
    u='http://127.0.0.1:2019'+path; routes=request(u)
    assert routes[0]['match'][0]['path']==['/sessions/*'], 'unexpected_routes'
    added={'match':[{'method':['GET','HEAD','OPTIONS'],'path':[PREFIX+'/sessions/*']}],
        'handle':[{'handler':'rewrite','strip_path_prefix':PREFIX},{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:18086'}]}]}
    record = {'path':path,'added':added,'before':routes}
    if (ROOT/'activation.private.json').exists():
        assert json.loads((ROOT/'activation.private.json').read_text()) == record, 'activation_state_drift'
    else: save('activation.private.json', record)
    try:
        request(u,[added]+routes,'PATCH'); assert request(u)==[added]+routes
        q='begin; lock table public.cloud_runtime_config in row exclusive mode;'
        for k,v in s['old'].items():
            q+="do $$ begin if not exists(select 1 from public.cloud_runtime_config where key=%s and value=%s) then raise exception 'route changed'; end if; end $$;"%(quote(k),quote(v))
        q+="insert into public.media_gateways(id,gateway_name,region,base_url,status,capabilities) values(%s,'resume-cache-pilot','hel1',%s,'online','{\"protocol\":1,\"private\":true,\"canary\":true,\"video_encoder\":\"vaapi\"}');"%(quote(s['gid']),quote('http://'+NAME+':8080'))
        for k,v in s['values'].items(): q+='update public.cloud_runtime_config set value=%s where key=%s;'%(quote(v),quote(k))
        sql(q+'commit;'); assert config()=={**s['old'],**s['values']}
    except Exception:
        current=request(u)
        if added in current:
            current.remove(added); request(u,current,'PATCH')
        raise
    emit({'activatedPilot':True,'mainRestarted':False,'providerProxyConfigurationUnchanged':True})
def restore():
    s=state(); c=config()
    assert c==s['old'] or c=={**s['old'],**s['values']}, 'foreign_route_change'
    h=request('http://127.0.0.1:18086/health')
    assert h['activeSessions']==0 and h.get('rawPumpCount',0)==0, 'pilot_playback_active'
    q='begin;'
    for k,v in s['old'].items(): q+='update public.cloud_runtime_config set value=%s where key=%s;'%(quote(v),quote(k))
    q+="update public.media_gateways set status='maintenance' where id=%s;commit;"%quote(s['gid'])
    sql(q); assert config()==s['old']
    a=json.loads((ROOT/'activation.private.json').read_text()); u='http://127.0.0.1:2019'+a['path']; routes=request(u)
    if a['added'] in routes:
        routes.remove(a['added']); request(u,routes,'PATCH')
    assert a['added'] not in request(u)
    run(['docker','stop','--time','15',NAME])
    emit({'routingRestored':True,'pilotStopped':True,'mainUnchanged':inspect('norva-media-gateway')['Id']==s['mainId']})
def status():
    s=state(); h=request('http://127.0.0.1:18086/health')
    emit({'pilotRouted':config()=={**s['old'],**s['values']},'mainUnchanged':inspect('norva-media-gateway')['Id']==s['mainId'],
        **{k:h.get(k) for k in ['activeSessions','transcribeQueueDepth','privateResumeByteRanges','privateResumeHlsCache']}})
def diagnostics():
    code="""(async()=>{const r=await fetch('http://127.0.0.1:8080/debug/sessions',{headers:{authorization:'Bearer '+process.env.GATEWAY_TOKEN}});console.log(JSON.stringify(await r.json()));})().catch(()=>process.exitCode=1);"""
    data=json.loads(run(['docker','exec',NAME,'node','-e',code]))
    result=[]
    for row in data.get('sessions',[]):
        item={k:row.get(k) for k in ['status','mode','requestedSeekOffset','actualStartOffset','codecProfileSource','inputProbeMode']}
        item['timings']={k:v for k,v in (row.get('startupTimings') or {}).items() if isinstance(v,(int,float,bool)) or k=='providerValidatorEvidence'}
        result.append(item)
    logs=subprocess.run(['docker','logs','--tail','200',NAME],capture_output=True,text=True)
    errors=re.findall(r'(?:ReferenceError|TypeError|SyntaxError): [A-Za-z0-9_ .():-]{1,160}',logs.stdout+logs.stderr)
    failures=json.loads(run(['docker','exec',NAME,'node','-e',code.replace('/debug/sessions','/debug/failures')]))
    signals=[]
    for f in failures.get('failures',[])[-3:]:
        value=str(f.get('detail',''))+' '+str(f.get('logTail',''))
        signals.append({'status':f.get('status'),'signals':[x for x in ['timeout','403','500','IDENTITY','subtitle','cache','not defined','not a function'] if x.lower() in value.lower()]})
    emit({'sessions':result,'runtimeErrors':errors,'failures':signals})
if __name__=='__main__':
    try:
        assert len(sys.argv)==2 and sys.argv[1] in ['stage','activate','restore','status','diagnostics']
        globals()[sys.argv[1]]()
    except Exception as e:
        emit({'error':str(e) if isinstance(e,AssertionError) else type(e).__name__}); sys.exit(1)
