"""Scoped follow-up to the existing native MP4 pilot; retain both old replicas."""
import importlib.util, json, pathlib, shutil, sys, time
s=importlib.util.spec_from_file_location('release','/home/adrien/.norva/storyboard-compression-20260916/release.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path('/home/adrien/.norva/resume-cache-prefix-20260916')
PREVIOUS=pathlib.Path('/home/adrien/.norva/resume-cache-pilot-20260916')
NAMES=['norva-edge-functions','norva-edge-functions-2']
FILES=['norva-playback/index.ts','_shared/native-mp4-gateway-policy.mjs']
def emit(v): print(json.dumps(v),flush=True)
def save(n,v): m.gw.private_write(ROOT/n,v)
def read(n): return json.loads((ROOT/n).read_text())
def stage():
    assert not (ROOT/'plan.private.json').exists(),'already_staged'
    old={n:m.gw.inspect(n) for n in NAMES}
    prior=json.loads((PREVIOUS/'edge-plan.private.json').read_text())
    roots={m.lib.edge_root(c) for c in old.values()};assert len(roots)==1,'different_roots'
    root=roots.pop(); before=m.edge.hashes(root)
    assert before==prior['after'],'live_code_changed'
    tree=ROOT/'functions';shutil.copytree(root,tree)
    for name in FILES: shutil.copyfile(ROOT/'input'/name,tree/name)
    after=m.edge.hashes(tree)
    assert {k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)}==set(FILES),'unexpected_files'
    expected={n:m.r.configured(m.lib.edge_expected(c,tree),'NORVA_NATIVE_MP4_PILOT_PUBLIC_BASE_URL',
        'https://media.norva.tv/resume-cache-pilot-20260916') for n,c in old.items()}
    for c in old.values():m.lib.edge_health(c)
    save('plan.private.json',{'old':old,'expected':expected,'before':before,'after':after})
    emit({'staged':True,'changedFiles':FILES})
def rollback():
    p=read('plan.private.json')
    for n in reversed(NAMES):
        if not (ROOT/(n+'.receipt.json')).exists():continue
        cid=read(n+'.receipt.json')['id'];c=m.gw.inspect(cid)
        if c['State']['Running']:m.gw.run(['docker','stop','--time','20',cid])
        if c['Name']=='/'+n:m.gw.run(['docker','rename',cid,n+'-prefix-rejected-20260916'])
        old=m.gw.inspect(p['old'][n]['Id'])
        if old['Name']!='/'+n:m.gw.run(['docker','rename',old['Id'],n])
        if not old['State']['Running']:m.gw.run(['docker','start',old['Id']])
        m.lib.edge_health(m.gw.inspect(n))
    emit({'rollbackVerified':True})
def activate():
    p=read('plan.private.json')
    assert m.edge.hashes(ROOT/'functions')==p['after'],'candidate_changed'
    for n in NAMES:
        assert m.gw.inspect(n)['Id']==p['old'][n]['Id'],'foreign_container'
        assert m.edge.hashes(m.lib.edge_root(p['old'][n]))==p['before'],'live_code_changed'
    try:
        for n in NAMES:
            m.lib.edge_health(m.gw.inspect(next(x for x in NAMES if x!=n)))
            old=p['old'][n];want=p['expected'][n]
            c=m.gw.docker_api('POST','/containers/create?name='+n+'-prefix-candidate-20260916',m.gw.clone_payload(want,old['Config']['Image']))
            save(n+'.receipt.json',{'id':c['Id']})
            m.gw.assert_clone(want,m.gw.inspect(c['Id']),old['Config']['Image'])
            m.gw.run(['docker','stop','--time','20',old['Id']])
            m.gw.run(['docker','rename',old['Id'],n+'-prefix-retained-20260916'])
            m.gw.run(['docker','rename',c['Id'],n]);m.gw.run(['docker','start',c['Id']])
            ready=False
            for _ in range(30):
                try:m.lib.edge_health(m.gw.inspect(n));ready=True;break
                except Exception:time.sleep(1)
            assert ready,'readiness_failed'
            m.gw.assert_clone(want,m.gw.inspect(n),old['Config']['Image'])
            emit({'replicaActivated':n,'healthy':True})
    except BaseException:rollback();raise
if __name__=='__main__':
    try:
        assert len(sys.argv)==2 and sys.argv[1] in ('stage','activate','rollback')
        globals()[sys.argv[1]]()
    except Exception as e:
        emit({'error':str(e) if isinstance(e,AssertionError) else type(e).__name__});sys.exit(1)
