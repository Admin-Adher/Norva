import importlib.util,json,pathlib,time,urllib.request
s=importlib.util.spec_from_file_location('release','/home/adrien/.norva/storyboard-compression-20260916/release.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path('/home/adrien/.norva/resume-cache-prefix-20260916')
NAME='norva-resume-cache-pilot-20260916'
IMAGE='norva-media-gateway:resume-native-pilot-20260916'
def request(path,secret=None,body=None):
    headers={'Content-Type':'application/json'}
    if secret:headers['Authorization']='Bearer '+secret
    req=urllib.request.Request('http://127.0.0.1:18086'+path,headers=headers,
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=10) as r:return json.load(r)
def main():
    assert not (ROOT/'gateway-receipt.private.json').exists(),'already_started'
    old=m.gw.inspect(NAME);mainId=m.gw.inspect('norva-media-gateway')['Id']
    assert old['Config']['Image']=='norva-media-gateway:resume-maintenance-candidate-20260916','foreign_pilot'
    env=dict(x.split('=',1) for x in old['Config']['Env'])
    owner=env['PRIVATE_RESUME_CACHE_OWNER_HASHES']
    assert len(owner)==64 and all(c in '0123456789abcdef' for c in owner),'invalid_owner'
    health=request('/health');assert health['activeSessions']==0 and health['transcribeQueueDepth']==0,'pilot_busy'
    want=m.r.configured(old,'NATIVE_MP4_PILOT_OWNER_HASHES',owner)
    c=m.gw.docker_api('POST','/containers/create?name='+NAME+'-native-candidate',m.gw.clone_payload(want,IMAGE))
    m.gw.assert_clone(want,m.gw.inspect(c['Id']),IMAGE)
    m.gw.private_write(ROOT/'gateway-receipt.private.json',{'old':old,'new':c['Id']})
    prepared=request('/maintenance/prepare',env['GATEWAY_TOKEN'],{})
    assert prepared.get('ready'),'maintenance_not_ready'
    assert request('/maintenance/commit',env['GATEWAY_TOKEN'],{'token':prepared['token']}).get('committed'),'maintenance_not_committed'
    try:
        m.gw.run(['docker','stop','--time','20',old['Id']])
        m.gw.run(['docker','rename',old['Id'],NAME+'-native-retained'])
        m.gw.run(['docker','rename',c['Id'],NAME]);m.gw.run(['docker','start',c['Id']])
        ready=False
        for _ in range(30):
            try:
                h=request('/health');ready=bool(h.get('ok'))
                if ready:break
            except Exception:pass
            time.sleep(1)
        assert ready,'not_healthy'
        assert m.gw.inspect('norva-media-gateway')['Id']==mainId,'main_changed'
        print(json.dumps({'pilotActivated':True,'maintenanceCommitted':True,'healthy':True,'mainUnchanged':True}))
    except BaseException:
        candidate=m.gw.inspect(c['Id'])
        if candidate['State']['Running']:m.gw.run(['docker','stop','--time','20',c['Id']])
        if candidate['Name']=='/'+NAME:m.gw.run(['docker','rename',c['Id'],NAME+'-native-rejected'])
        original=m.gw.inspect(old['Id'])
        if original['Name']!='/'+NAME:m.gw.run(['docker','rename',old['Id'],NAME])
        m.gw.run(['docker','start',old['Id']]);raise
try:main()
except Exception as e:
    print(json.dumps({'error':str(e) if isinstance(e,AssertionError) else type(e).__name__}));raise SystemExit(1)
