"""One Edge file, unchanged Gateway and SQL, retained replicas and idle recovery.

Uses the already-tested exact-container supervisor; the adapters below change
only fresh artifact paths, the single reviewed source delta and receipt wording.
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile
import time

ROOT=pathlib.Path('/home/adrien/.norva/profile-share-diagnostics-20260913')
PARENT=ROOT.parent/'scoped-capture-jobs-release-20260913'
SUFFIX='profile-share-diagnostics-20260913'


def load(name):
    spec=importlib.util.spec_from_file_location(name,PARENT/'deploy-scoped-capture-jobs-20260913.py')
    result=importlib.util.module_from_spec(spec);sys.modules[name]=result;spec.loader.exec_module(result);return result


previous=load('profile_share_previous')
base=load('profile_share_supervisor')
base.ROOT,base.__file__=ROOT,__file__
base.fleet.ROOT=ROOT
gw,require=base.gw,base.require
save,saved=base.save,base.saved


def archive_payload(kind):
    with tarfile.open(ROOT/(kind+'.tar')) as archive:
        entries=[e for e in archive.getmembers() if not e.isdir()]
        require(len(entries)==1 and entries[0].name=='supabase/functions/'+base.FILE and entries[0].isfile()
            and 0<entries[0].size<4000000,'archive_scope')
        return archive.extractfile(entries[0]).read().replace(b'\r\n',b'\n')


def source_delta(live,baseline,candidate):
    normalize=lambda value:value.replace(b'\r\n',b'\n')
    live,baseline,candidate=map(normalize,(live,baseline,candidate))
    require(live==baseline,'edge_baseline_drift')
    require(b'function recordFinalGatewayProfileShareDiagnostic(' not in baseline
        and candidate.count(b'function recordFinalGatewayProfileShareDiagnostic(')==1
        and candidate.count(b'event: "final_gateway_profile_share"')==1
        and b'onDiagnostic: diagnose,' in candidate,'diagnostic_candidate_mismatch')
    return candidate


def stage():
    commit=sys.argv[2];require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
    old_plan=previous.saved('plan.private.json');previous.invariant(old_plan);previous.verify_sql()
    require(previous.saved('closed.private.json').get('updated') is True,'previous_release_not_closed')
    for name in base.SERVICES:previous.verify_edge(old_plan,name,True)
    originals={name:gw.inspect(name) for name in base.SERVICES}
    roots=[base.lib.edge_root(c) for c in originals.values()];require(len(set(roots))==1,'replica_trees_differ')
    old=roots[0];changed=source_delta((old/base.FILE).read_bytes(),archive_payload('base'),archive_payload('candidate'))
    before=base.edge.hashes(old);target=ROOT/'functions';shutil.copytree(old,target)
    (target/base.FILE).write_bytes(changed);(target/base.FILE).chmod(0o644);after=base.edge.hashes(target)
    require(set(after)==set(before) and all(after[n]==digest for n,digest in before.items() if n!=base.FILE),'unrelated_edge_change')
    closed_pilot=ROOT.parent/'passive-job-canary-20260913/closed.private.json'
    require(json.loads(closed_pilot.read_text()).get('restored') is True,'passive_pilot_not_closed')
    protected=[pathlib.Path(p) for p in old_plan['protectedFiles']]
    protected += [PARENT/'plan.private.json',PARENT/'closed.private.json',closed_pilot,pathlib.Path(__file__),ROOT/'base.tar',ROOT/'candidate.tar']
    plan={'commit':commit,'stagedAt':time.time(),'containers':originals,'before':before,'after':after,
        'gateway':gw.inspect(),'gatewaySources':base.parent.source_snapshot(),'binaries':gw.binary_snapshot(),
        'runtime':gw.runtime_snapshot(gw.health()),'controls':base.core.base.r.controls(),'crons':base.core.base.r.crons(),
        'otherContainers':old_plan['otherContainers'],'protectedFiles':{str(p):base.sha(p.read_bytes()) for p in protected}}
    save('plan.private.json',plan);base.invariant(plan)
    for name in base.SERVICES:base.verify_edge(plan,name,False)
    print(json.dumps({'staged':True,'commit':commit,'edgeFiles':1,'sqlChanges':0,'productionUnchanged':True}))


def activate(plan,name):
    base.invariant(plan);base.verify_sql();base.verify_edge(plan,name,False);base.idle()
    require(base.process_alive('watch'),'guard_missing')
    other=base.SERVICES[1] if name==base.SERVICES[0] else base.SERVICES[0];base.lib.edge_health(gw.inspect(other))
    original=plan['containers'][name];expected=base.lib.edge_expected(original,ROOT/'functions')
    created=gw.docker_api('POST','/containers/create?name='+name+'-'+SUFFIX+'-candidate',gw.clone_payload(expected,original['Config']['Image']))
    save(name+'-receipt.private.json',{'candidateContainer':created['Id'],'candidateName':name+'-'+SUFFIX+'-candidate'})
    gw.assert_clone(expected,gw.inspect(created['Id']),original['Config']['Image'])
    base.idle();require(base.process_alive('watch'),'guard_missing')
    gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-'+SUFFIX+'-retained'])
    gw.run(['docker','rename',created['Id'],name]);gw.run(['docker','start',created['Id']])
    for attempt in range(25):
        try:base.verify_edge(plan,name,True);return
        except Exception:
            if attempt==24:raise
            time.sleep(1)


def run():
    plan=saved('plan.private.json')
    try:
        base.invariant(plan);base.verify_sql();base.core.base.r.alter_crons(plan,True)
        while time.time()<saved('begin.private.json')['deadline']-120:
            try:base.idle();break
            except Exception:time.sleep(5)
        else:raise RuntimeError('work_drain_deadline')
        require(base.process_alive('watch'),'guard_missing')
        for name in base.SERVICES:activate(plan,name)
        base.invariant(plan);base.verify_sql()
        for name in base.SERVICES:base.verify_edge(plan,name,True)
        base.core.base.r.alter_crons(plan,False);require(base.core.base.r.crons()==plan['crons'],'cron_restore_missing')
        save('closed.private.json',{'at':time.time(),'updated':True,'sqlChanged':False,'gatewayChanged':False,
            'cronsRestored':True,'approvals':0})
    except Exception:
        save('failed.private.json',{'at':time.time(),'requiresRecovery':True});raise


base.stage,base.activate,base.run=stage,activate,run


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1];require(phase in ('stage','launch','run','watch','status'),'invalid_phase');getattr(base,phase)()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code)
            else 'profile_share_deployment_failed'}));sys.exit(1)
