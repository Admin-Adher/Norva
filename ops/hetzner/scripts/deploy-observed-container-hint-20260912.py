"""One Edge file, two idle replicas. Gateway, flags, proxy and data stay unchanged."""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import time

ROOT=pathlib.Path('/home/adrien/.norva/observed-container-hint-20260912')
FILE='norva-playback/index.ts'
BASE_SHA='456c0c9b1957a79153507fdc4c86c0f9e146f8fdaa395b21759b71217ced23f4'


def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m


live=load('observed_container_live',ROOT.parent/'ts-quick-start-20260912/deploy-ts-quick-start-20260912.py')
op=load('observed_container_supervisor',ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT=ROOT;op.__file__=__file__
gw,lib,edge,require=op.gw,op.lib,op.edge,op.require
EDGES=live.EDGES


def verify_edge(name,plan,candidate):
    original=plan['edges'][name];current=gw.inspect(name)
    expected_id=op.saved(name+'-receipt.private.json')['candidateContainer'] if candidate else original['Id']
    require(current['Id']==expected_id,'edge_not_owned')
    expected=lib.edge_expected(original,ROOT/'functions') if candidate else original
    gw.assert_clone(expected,current,original['Config']['Image'])
    require(current['Image']==original['Image'],'edge_image_changed')
    require(edge.hashes(lib.edge_root(current))==plan['after' if candidate else 'before'],'edge_source_drift')
    lib.edge_health(current)
    require(current['State']['Running'] and current['RestartCount']==0 and not current['State']['OOMKilled'],'edge_unhealthy')


def verify_gateway(plan,_candidate):
    live.verify_gateway(live.op.saved('plan.private.json'),True)


def invariant(plan):
    op.base.previous.invariant(op.base.previous.saved('plan.private.json'))
    require(op.base.r.controls()==plan['controls'],'controls_changed')
    for name,digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(name).read_bytes())==digest,'protected_evidence_changed')
    verify_gateway(plan,True)
    for name in EDGES:verify_edge(name,plan,gw.inspect(name)['Id']!=plan['edges'][name]['Id'])
    require(gw.inspect(op.base.previous.d.SERVICES[3])['Id']==plan['selectionId'],'selection_changed')


def stage():
    commit=sys.argv[2];require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
    live.verify()
    edges={name:gw.inspect(name) for name in EDGES};roots={lib.edge_root(v) for v in edges.values()}
    require(len(roots)==1,'replica_source_drift');old=roots.pop();before=edge.hashes(old)
    require(before[FILE]==BASE_SHA,'edge_baseline_drift')
    source=(ROOT/'candidate.ts').read_bytes().replace(b'\r\n',b'\n')
    require(500000<len(source)<2000000 and b'function bindObservedContainerPlaybackHint(' in source,'candidate_invalid')
    shutil.copytree(old,ROOT/'functions');(ROOT/'functions'/FILE).write_bytes(source)
    after=edge.hashes(ROOT/'functions')
    require(set(before)==set(after) and all(after[k]==v for k,v in before.items() if k!=FILE),'unrelated_edge_change')
    parent_plan=live.op.saved('plan.private.json')
    paths=[pathlib.Path(n) for n in parent_plan['protectedFiles']]
    paths += [live.ROOT/n for n in ('plan.private.json','closed.private.json')]
    paths += [ROOT/'candidate.ts',pathlib.Path(__file__),ROOT.parent/'container-binding-20260912/applied.private.json']
    plan={'commit':commit,'edges':edges,'before':before,'after':after,'original':gw.inspect(op.SERVICE),
        'crons':op.base.r.crons(),'controls':op.base.r.controls(),
        'selectionId':gw.inspect(op.base.previous.d.SERVICES[3])['Id'],
        'protectedFiles':{str(p):gw.sha(p.read_bytes()) for p in paths},'stagedAt':time.time()}
    op.save('plan.private.json',plan);invariant(plan)
    print(json.dumps({'staged':True,'edgeFiles':1,'otherEdgeFilesPreserved':len(before)-1,'productionUnchanged':True}))


def deploy(plan):
    require(op.base.r.crons()==[{**j,'active':False} for j in plan['crons']],'crons_not_paused')
    for name in EDGES:
        invariant(plan);verify_edge(name,plan,False);op.base.previous.d.idle()
        original=plan['edges'][name];candidate_name=name+'-observed-container-hint-20260912-candidate'
        require(not (ROOT/(name+'-receipt.private.json')).exists(),'activation_already_attempted')
        expected=lib.edge_expected(original,ROOT/'functions')
        result=gw.docker_api('POST','/containers/create?name='+candidate_name,gw.clone_payload(expected,original['Config']['Image']))
        op.save(name+'-receipt.private.json',{'candidateContainer':result['Id'],'candidateName':candidate_name})
        gw.assert_clone(expected,gw.inspect(result['Id']),original['Config']['Image']);op.base.previous.d.idle()
        gw.run(['docker','stop','--time','20',original['Id']])
        gw.run(['docker','rename',original['Id'],name+'-observed-container-hint-20260912-retained'])
        gw.run(['docker','rename',result['Id'],name]);gw.run(['docker','start',result['Id']])
        for attempt in range(25):
            try:verify_edge(name,plan,True);break
            except Exception:
                if attempt==24:raise
                time.sleep(1)


def recover():
    plan=op.saved('plan.private.json');verify_gateway(plan,True)
    receipts={name:op.saved(name+'-receipt.private.json') for name in EDGES if (ROOT/(name+'-receipt.private.json')).exists()}
    inventory=gw.docker_api('GET','/containers/json?all=true');current={}
    for name in EDGES:
        matches=[c['Id'] for c in inventory if '/'+name in c.get('Names',[])]
        require(len(matches)<=1,'recovery_alias_ambiguous');current[name]=matches[0] if matches else None
        require(current[name] is not None or name in receipts,'recovery_receipt_missing')
        require(current[name] in (plan['edges'][name]['Id'],receipts.get(name,{}).get('candidateContainer'),None),'recovery_not_owned')
    if len(receipts)==2 and all(current[n]==receipts[n]['candidateContainer'] for n in EDGES):
        try:invariant(plan)
        except Exception:pass
        else:op.restore_crons(plan);return True
    if any(current[n]!=plan['edges'][n]['Id'] for n in EDGES):op.base.previous.d.idle()
    for name in reversed(EDGES):
        if current[name]!=plan['edges'][name]['Id']:edge.restore(name,{'containers':plan['edges']},receipts[name])
    invariant(plan);op.restore_crons(plan);return False


def close(success):
    plan=op.saved('plan.private.json');invariant(plan)
    for name in EDGES:verify_edge(name,plan,success)
    require(op.base.r.crons()==plan['crons'],'crons_not_restored')
    op.save('closed.private.json',{'at':time.time(),'productionUpdated':success,'cronsRestored':True,'gatewayRestarted':False})


def verify():
    plan=op.saved('plan.private.json');require(op.saved('closed.private.json')['productionUpdated'],'release_not_complete')
    invariant(plan);require(op.base.r.crons()==plan['crons'],'crons_not_restored')
    print(json.dumps({'verified':True,'commit':plan['commit'],'edgeFiles':1,'gatewayRestarted':False,'newProviderRequests':0}))


op.invariant,op.verify_gateway,op.deploy,op.recover,op.close=invariant,verify_gateway,deploy,recover,close
if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1];require(phase in ('stage','launch','run','watch','recover','verify'),'invalid_phase')
        stage() if phase=='stage' else verify() if phase=='verify' else getattr(op,phase)()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'observed_container_release_failed'}),flush=True);sys.exit(1)
