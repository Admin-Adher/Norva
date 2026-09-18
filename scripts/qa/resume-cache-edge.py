"""Two-file pilot-only Edge overlay. Keep one healthy replica during replacement."""
import importlib.util, json, pathlib, shutil, subprocess, sys, time, hashlib
s=importlib.util.spec_from_file_location('release','/home/adrien/.norva/storyboard-compression-20260916/release.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path('/home/adrien/.norva/resume-cache-pilot-20260916')
SERVICES=['norva-edge-functions','norva-edge-functions-2']
def emit(x): print(json.dumps(x),flush=True)
def read(n): return json.loads((ROOT/n).read_text())
def save(n,x): m.gw.private_write(ROOT/n,x)
def stage():
    assert not (ROOT/'edge-plan.private.json').exists(), 'already_staged'
    old={n:m.gw.inspect(n) for n in SERVICES}
    roots={m.lib.edge_root(c) for c in old.values()}; assert len(roots)==1,'different_roots'
    root=roots.pop(); tree=ROOT/'edge-tree'; (tree/'supabase').mkdir(parents=True,mode=0o700)
    shutil.copytree(root,tree/'supabase/functions')
    before=m.edge.hashes(root)
    for args in [['git','apply','--check',str(ROOT/'edge.patch')],['git','apply',str(ROOT/'edge.patch')]]:
        subprocess.run(args,cwd=tree,check=True,capture_output=True)
    after=m.edge.hashes(tree/'supabase/functions')
    assert {k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)}=={'norva-playback/index.ts','_shared/native-mp4-gateway-policy.mjs'},'unexpected_files'
    owner=read('state.private.json')['values']['NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES']
    expected={n:m.r.configured(m.lib.edge_expected(c,tree/'supabase/functions'),'NORVA_NATIVE_MP4_GATEWAY_OWNER_HASHES',owner) for n,c in old.items()}
    save('edge-plan.private.json',{'old':old,'expected':expected,'before':before,'after':after,
        'operator':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()})
    for c in old.values(): m.lib.edge_health(c)
    emit({'edgeStaged':True,'changedFiles':2,'ownerScoped':True,'productionUnchanged':True})
def rollback():
    p=read('edge-plan.private.json')
    for n in reversed(SERVICES):
        receipt=ROOT/(n+'.edge-receipt.private.json')
        if not receipt.exists(): continue
        rec=read(receipt.name); old=p['old'][n]
        candidate=m.gw.inspect(rec['id'])
        if candidate['State']['Running']: m.gw.run(['docker','stop','--time','20',rec['id']])
        if candidate['Name']=='/'+n: m.gw.run(['docker','rename',rec['id'],n+'-resume-cache-rejected-20260916'])
        original=m.gw.inspect(old['Id'])
        if original['Name']!='/'+n: m.gw.run(['docker','rename',old['Id'],n])
        if not original['State']['Running']: m.gw.run(['docker','start',old['Id']])
        m.lib.edge_health(m.gw.inspect(n))
    emit({'edgeRollbackVerified':True})
def activate():
    p=read('edge-plan.private.json')
    assert hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()==p['operator'],'operator_changed'
    assert m.edge.hashes(ROOT/'edge-tree/supabase/functions')==p['after'],'candidate_changed'
    for n in SERVICES:
        assert m.gw.inspect(n)['Id']==p['old'][n]['Id'],'foreign_container'
        assert m.edge.hashes(m.lib.edge_root(p['old'][n]))==p['before'],'live_code_changed'
        m.lib.edge_health(m.gw.inspect(n))
    try:
        for n in SERVICES:
            other=next(x for x in SERVICES if x!=n); m.lib.edge_health(m.gw.inspect(other))
            old=p['old'][n]; want=p['expected'][n]
            c=m.gw.docker_api('POST','/containers/create?name='+n+'-resume-cache-candidate-20260916',m.gw.clone_payload(want,old['Config']['Image']))
            save(n+'.edge-receipt.private.json',{'id':c['Id']})
            m.gw.assert_clone(want,m.gw.inspect(c['Id']),old['Config']['Image'])
            m.gw.run(['docker','stop','--time','20',old['Id']])
            m.gw.run(['docker','rename',old['Id'],n+'-resume-cache-retained-20260916'])
            m.gw.run(['docker','rename',c['Id'],n]); m.gw.run(['docker','start',c['Id']])
            ready=False
            for _ in range(30):
                try: m.lib.edge_health(m.gw.inspect(n)); ready=True; break
                except Exception: time.sleep(1)
            assert ready,'readiness_failed'
            m.gw.assert_clone(want,m.gw.inspect(n),old['Config']['Image'])
            emit({'replicaActivated':n,'healthy':True})
        save('edge-success.private.json',{'at':time.time()})
    except BaseException:
        rollback(); raise
if __name__=='__main__':
    try:
        assert len(sys.argv)==2 and sys.argv[1] in ['stage','activate','rollback']
        globals()[sys.argv[1]]()
    except Exception as e:
        emit({'error':str(e) if isinstance(e,AssertionError) else type(e).__name__});sys.exit(1)
