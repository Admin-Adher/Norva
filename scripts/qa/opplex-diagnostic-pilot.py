import importlib.util,json,pathlib,subprocess,time,urllib.request
s=importlib.util.spec_from_file_location('release','/home/adrien/.norva/storyboard-compression-20260916/release.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path('/home/adrien/.norva/opplex-diagnostic-20260916')
NAME='norva-resume-cache-pilot-20260916'
IMAGE='norva-media-gateway:opplex-diagnostic-20260916'
def request(path,secret=None,body=None):
    headers={'Content-Type':'application/json'}
    if secret:headers['Authorization']='Bearer '+secret
    req=urllib.request.Request('http://127.0.0.1:18086'+path,headers=headers,data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=10) as r:return json.load(r)
def main():
    ROOT.mkdir(mode=0o700,exist_ok=True)
    assert not (ROOT/'receipt.private.json').exists(),'already_started'
    old=m.gw.inspect(NAME);mainId=m.gw.inspect('norva-media-gateway')['Id']
    assert old['Config']['Image']=='norva-media-gateway:resume-native-pilot-20260916','foreign_pilot'
    env=dict(x.split('=',1) for x in old['Config']['Env'])
    health=request('/health')
    assert health['activeSessions']==0 and health.get('rawPumpCount',0)==0 and health['transcribeQueueDepth']==0,'pilot_busy'
    source=subprocess.check_output(['docker','exec',NAME,'cat','/app/src/index.js']).decode()
    before="console.warn('[media-gateway] unable to bound finite MKV input:', sanitizeLog(err?.message || String(err), sourceUrl));"
    after="console.warn('[media-gateway] unable to bound finite MKV input:', sanitizeLog(err?.message || String(err), sourceUrl), { upstreamStatus: Number.isInteger(err?.upstreamStatus) && err.upstreamStatus >= 100 && err.upstreamStatus <= 599 ? err.upstreamStatus : null, retryable: err?.retryable === true });"
    assert source.count(before)==1,'unexpected_code'
    (ROOT/'index.js').write_text(source.replace(before,after))
    assert json.loads(subprocess.check_output(['docker','image','inspect',old['Config']['Image']]))[0]['Id']==old['Image'],'base_tag_changed'
    (ROOT/'Dockerfile').write_text('FROM '+old['Config']['Image']+'\nCOPY --chmod=0644 index.js /app/src/index.js\n')
    subprocess.check_call(['docker','build','-q','-t',IMAGE,str(ROOT)],stdout=subprocess.DEVNULL)
    subprocess.check_call(['docker','run','--rm','--network','none','--entrypoint','node',IMAGE,'--check','/app/src/index.js'])
    c=m.gw.docker_api('POST','/containers/create?name='+NAME+'-diagnostic-candidate',m.gw.clone_payload(old,IMAGE))
    m.gw.assert_clone(old,m.gw.inspect(c['Id']),IMAGE)
    m.gw.private_write(ROOT/'receipt.private.json',{'old':old,'new':c['Id']})
    prepared=request('/maintenance/prepare',env['GATEWAY_TOKEN'],{})
    assert prepared.get('ready'),'maintenance_not_ready'
    assert request('/maintenance/commit',env['GATEWAY_TOKEN'],{'token':prepared['token']}).get('committed'),'maintenance_not_committed'
    try:
        m.gw.run(['docker','stop','--time','20',old['Id']]);m.gw.run(['docker','rename',old['Id'],NAME+'-diagnostic-retained'])
        m.gw.run(['docker','rename',c['Id'],NAME]);m.gw.run(['docker','start',c['Id']])
        ready=False
        for _ in range(30):
            try:
                ready=bool(request('/health').get('ok'))
                if ready:break
            except Exception:pass
            time.sleep(1)
        assert ready,'not_healthy'
        assert m.gw.inspect('norva-media-gateway')['Id']==mainId,'main_changed'
        print(json.dumps({'pilotActivated':True,'maintenanceCommitted':True,'healthy':True,'mainUnchanged':True}))
    except BaseException:
        candidate=m.gw.inspect(c['Id'])
        if candidate['State']['Running']:m.gw.run(['docker','stop','--time','20',c['Id']])
        if candidate['Name']=='/'+NAME:m.gw.run(['docker','rename',c['Id'],NAME+'-diagnostic-rejected'])
        if m.gw.inspect(old['Id'])['Name']!='/'+NAME:m.gw.run(['docker','rename',old['Id'],NAME])
        m.gw.run(['docker','start',old['Id']]);raise
try:main()
except Exception as e:
    print(json.dumps({'error':str(e) if isinstance(e,AssertionError) else type(e).__name__}));raise SystemExit(1)
