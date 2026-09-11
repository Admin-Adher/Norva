"""Rolling, single-module Edge release for the metadata presence gate.

Original read-only function trees and stopped containers are retained. No schema,
Gateway image/model, environment, flags, queues or user checkout changes.
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import time

ROOT=pathlib.Path('/home/adrien/.norva/codec-profile-presence-20260911')
spec=importlib.util.spec_from_file_location('existing_release',pathlib.Path(__file__).with_name('deploy-lid-cache-audio-20260911.py'))
lib=importlib.util.module_from_spec(spec);spec.loader.exec_module(lib)
gw=lib.gw
SERVICES=('norva-edge-functions','norva-edge-functions-2')
FILE='norva-playback/index.ts'
BASE='f46ba6ba1d1440b874c68a99fcaf7923ce3cf7f0ca7fff9b2fb44f5eb01dd710'
GATEWAY='32e51bfedaee19c4727f2bc0f75831f859448588db0e963c29a8f2de425abc14'


def read(name):return json.loads(gw.safe_file(ROOT,name).read_text())


def hashes(root):
    result={}
    for p in root.rglob('*'):
        gw.require(not p.is_symlink(),'symlink_in_functions')
        if p.is_file():result[p.relative_to(root).as_posix()]=gw.sha(p.read_bytes())
    return result


def stage(commit):
    gw.require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'invalid_commit')
    gw.require(not (ROOT/'plan.private.json').exists(),'plan_exists')
    originals={name:gw.inspect(name) for name in SERVICES}
    sources=[lib.edge_root(c) for c in originals.values()]
    gw.require(len(set(sources))==1,'edge_sources_diverged')
    old=sources[0]
    gw.require(lib.digest((old/FILE).read_bytes())==BASE,'edge_baseline_changed')
    for c in originals.values():lib.edge_health(c)
    before=hashes(old)
    target=ROOT/'functions';shutil.copytree(old,target)
    candidate=gw.safe_file(ROOT,'candidate.ts').read_bytes().replace(b'\r\n',b'\n')
    (target/FILE).write_bytes(candidate)
    for p in target.rglob('*'):
        if p.is_file():p.chmod(0o644)
    after=hashes(target)
    gw.require(set(before)==set(after),'file_set_changed')
    gw.require(all(v==after[k] for k,v in before.items() if k!=FILE),'unrelated_file_changed')
    runtime=gw.runtime_snapshot(gw.health())
    gw.require(gw.source_snapshot()['index.js']==GATEWAY,'gateway_changed')
    plan={'protocol':1,'commit':commit,'containers':originals,'before':before,'after':after,
        'runtime':runtime,'candidateSha256':lib.digest(candidate),'sourceBefore':str(old)}
    gw.private_write(ROOT/'plan.private.json',plan)
    print(json.dumps({'staged':True,'commit':commit,'edgeSha256':plan['candidateSha256'],
        'unrelatedFilesPreserved':len(before)-1,'productionUnchanged':True}))


def verify(name,plan,candidate=True):
    original=plan['containers'][name];active=gw.inspect(name)
    expected=lib.edge_expected(original,ROOT/'functions') if candidate else original
    gw.assert_clone(expected,active,original['Config']['Image'])
    gw.require(active['Image']==original['Image'],'image_changed')
    gw.require(hashes(lib.edge_root(active))==plan['after' if candidate else 'before'],'function_tree_changed')
    lib.edge_health(active)
    gw.require(active['RestartCount']==0 and not active['State']['OOMKilled'],'restart_or_oom')


def restore(name,plan,receipt):
    candidate=gw.inspect(receipt['candidateContainer'])
    if candidate['State']['Running']:gw.run(['docker','stop','--time','20',candidate['Id']])
    if candidate['Name']=='/'+name:gw.run(['docker','rename',candidate['Id'],receipt['candidateName']])
    old=gw.inspect(plan['containers'][name]['Id'])
    if old['Name']!='/'+name:gw.run(['docker','rename',old['Id'],name])
    if not old['State']['Running']:gw.run(['docker','start',old['Id']])


def activate(name):
    plan=read('plan.private.json');original=plan['containers'][name]
    gw.require(not (ROOT/(name+'-receipt.private.json')).exists(),'deployment_exists')
    gw.require(gw.inspect(name)['Id']==original['Id'],'container_changed')
    verify(name,plan,False)
    other=SERVICES[1] if name==SERVICES[0] else SERVICES[0]
    lib.edge_health(gw.inspect(other))
    gw.require(gw.source_snapshot()['index.js']==GATEWAY,'gateway_changed')
    gw.assert_runtime(gw.health(),plan['runtime'])
    gw.assert_idle(gw.health())
    expected=lib.edge_expected(original,ROOT/'functions')
    candidateName=name+'-codec-presence-candidate-20260911'
    created=gw.docker_api('POST','/containers/create?name='+candidateName,gw.clone_payload(expected,original['Config']['Image']))
    receipt={'candidateContainer':created['Id'],'candidateName':candidateName}
    gw.private_write(ROOT/(name+'-receipt.private.json'),receipt)
    gw.assert_clone(expected,gw.inspect(created['Id']),original['Config']['Image'])
    gw.assert_idle(gw.health())
    try:
        gw.run(['docker','stop','--time','20',original['Id']])
        gw.run(['docker','rename',original['Id'],name+'-codec-presence-rollback-20260911'])
        gw.run(['docker','rename',created['Id'],name])
        gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:verify(name,plan);ready=True;break
            except Exception:time.sleep(1)
        gw.require(ready,'candidate_not_ready')
    except Exception:
        restore(name,plan,receipt);verify(name,plan,False)
        raise RuntimeError('candidate_failed_original_restored') from None
    print(json.dumps({'service':name,'healthy':True,'commit':plan['commit'],
        'environmentAndLimitsPreserved':True,'originalRetained':True}))


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase=='stage':stage(sys.argv[2])
        elif phase=='edge1':activate(SERVICES[0])
        elif phase=='edge2':activate(SERVICES[1])
        elif phase=='verify':
            p=read('plan.private.json')
            for name in SERVICES:verify(name,p)
            gw.assert_runtime(gw.health(),p['runtime'])
            print(json.dumps({'bothReplicasVerified':True,'edgeSha256':p['candidateSha256'],
                'commit':p['commit'],'gatewayRuntimePreserved':True}))
        else:raise RuntimeError('invalid_phase')
    except Exception as error:
        message=str(error)
        print(json.dumps({'ok':False,'error':message if re.fullmatch('[a-z0-9_:-]{1,120}',message) else 'edge_release_failed'}))
        sys.exit(1)
