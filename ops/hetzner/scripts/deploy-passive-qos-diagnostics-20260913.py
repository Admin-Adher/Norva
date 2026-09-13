"""Idle-only dormant deployment of input timing and passive readiness diagnostics."""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT=pathlib.Path('/home/adrien/.norva/passive-qos-diagnostics-20260913')
PARENT=ROOT.parent/'passive-observed-grant-20260913'
NATIVE=ROOT.parent/'passive-qos-diagnostics-native-20260913-r2/native-proof.json'
IMAGE='norva-media-gateway:passive-qos-diagnostics-20260913'
FILES=('index.js','passive-lid-capture.js')


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value)
    return value


live=load('qos_diagnostics_parent',PARENT/'deploy-passive-observed-grant-20260913.py')
op=load('qos_diagnostics_supervisor',ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT,op.NATIVE,op.FILES,op.IMAGE=ROOT,NATIVE,FILES,IMAGE
op.PREFIX,op.__file__=op.SERVICE+'-'+ROOT.name,__file__
gw,require=op.gw,op.require


def source_snapshot():
    return live.source_snapshot()


def invariant(plan):
    live.invariant(live.op.saved('plan.private.json'))
    require(op.base.r.controls()==plan['controls'],'flags_or_quarantine_changed')
    for name,digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(name).read_bytes())==digest,'protected_evidence_changed')
    for name,identity in plan['otherContainers'].items():
        require(gw.inspect(name)['Id']==identity,'unrelated_container_changed')


def verify_gateway(plan,candidate):
    current=gw.inspect(op.SERVICE)
    expected=op.saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(current['Id']==expected,'gateway_container_not_owned')
    gw.assert_clone(plan['original'],current,IMAGE if candidate else plan['original']['Config']['Image'])
    gw.assert_container_image(current,plan['imageIdentity' if candidate else 'originalImageIdentity'])
    require(source_snapshot()==plan['after' if candidate else 'before'],'gateway_source_changed')
    require(gw.binary_snapshot()==plan['binaries'],'runtime_binary_changed')
    health=gw.health();gw.assert_runtime(health,plan['runtime'])
    fence=health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode')=='disabled'
        and fence.get('files')==0 and fence.get('passiveSources')==0,'dormant_admission_changed')
    require(current['State']['Running'] and current['RestartCount']==0 and not current['State']['OOMKilled'],
        'gateway_unhealthy')


def stage():
    commit=sys.argv[2]
    require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_missing')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
    live.verify();current=gw.inspect();gw.assert_image_backed_runtime(current)
    proof=json.loads(NATIVE.read_text())
    require(proof.get('exitCode')==0 and proof.get('counts')=={'tests':150,'pass':150,'fail':0,'skipped':0}
        and proof.get('networkDisabled') is True and proof.get('newProviderRequests')==0
        and proof.get('syntheticExtractionOnly') is True and proof.get('abortedReason') is None
        and proof.get('image')==current['Image'],'native_proof_mismatch')
    context=ROOT/'context';context.mkdir(mode=0o700)
    allowed={'services/media-gateway/src/'+name:name for name in FILES}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries=[entry for entry in archive.getmembers() if not entry.isdir()]
        require(len(entries)==len(FILES) and {entry.name for entry in entries}==set(allowed),'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0<entry.size<2000000,'archive_entry')
            data=archive.extractfile(entry).read().replace(b'\r\n',b'\n')
            require(gw.sha(data)==proof['sourceHashes'][entry.name],'native_source_drift')
            target=context/allowed[entry.name];target.write_bytes(data);target.chmod(0o600)
    before=source_snapshot();after={**before,**{name:gw.sha((context/name).read_bytes()) for name in FILES}}
    require(set(after)==set(before),'untracked_module')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+
        ''.join('COPY --chmod=0644 '+name+' /app/src/'+name+'\n' for name in FILES))
    base_tag='norva-passive-qos-diagnostics-base:20260913'
    gw.run(['docker','tag',current['Image'],base_tag])
    require(gw.image_identity(base_tag)['index']==current['Image'],'build_base_drift')
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base_tag,'-t',IMAGE,str(context)])
    for name in FILES:
        gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','.5','--memory','256m',
            '--entrypoint','node',IMAGE,'--check','/app/src/'+name])
    live.verify();parent=live.op.saved('plan.private.json')
    paths=[pathlib.Path(name) for name in parent['protectedFiles']]
    paths += [PARENT/name for name in ('plan.private.json','receipt.private.json','closed.private.json',
        'deploy-passive-observed-grant-20260913.py')]
    canary=ROOT.parent/'passive-qos-canary-20260913'
    paths += [canary/name for name in ('plan.private.json','receipt.private.json','closed.private.json')]
    paths += [NATIVE,pathlib.Path(__file__),ROOT/'source.tar']
    # Preserve the failed first native run too; a passing retry does not erase it.
    first_native=ROOT.parent/'passive-qos-diagnostics-native-20260913'
    paths += [first_native/name for name in ('native-proof.json','native-tests.log')]
    others=(*op.base.r.SERVICES,op.base.previous.d.SERVICES[3])
    plan={'commit':commit,'original':current,'before':before,'after':after,
        'originalImageIdentity':gw.image_identity(current['Image']),'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(),'runtime':gw.runtime_snapshot(gw.health()),'controls':op.base.r.controls(),
        'crons':op.base.r.crons(),'otherContainers':{name:gw.inspect(name)['Id'] for name in others},
        'protectedFiles':{str(name):gw.sha(name.read_bytes()) for name in paths},'stagedAt':time.time()}
    op.save('plan.private.json',plan);invariant(plan);verify_gateway(plan,False)
    print(json.dumps({'staged':True,'gatewayModules':2,'productionUnchanged':True,'newProviderRequests':0}))


def verify():
    plan=op.saved('plan.private.json')
    require(op.saved('closed.private.json').get('productionUpdated') is True,'deployment_not_complete')
    invariant(plan);verify_gateway(plan,True)
    require(op.base.r.crons()==plan['crons'],'cron_restore_missing')
    print(json.dumps({'verified':True,'commit':plan['commit'],'image':plan['imageIdentity']['index'],
        'sourceHashes':{name:plan['after'][name] for name in FILES},'productionUpdated':True,
        'gatewayModules':2,'cronsRestored':True,'passiveEnabled':False,'newProviderRequests':0}))


op.invariant,op.verify_gateway=invariant,verify_gateway
if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        require(phase in ('stage','launch','run','watch','recover','verify'),'invalid_phase')
        stage() if phase=='stage' else verify() if phase=='verify' else getattr(op,phase)()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code)
            else 'qos_diagnostics_release_failed'}));sys.exit(1)
