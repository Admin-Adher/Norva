"""Two diagnostic modules only; no new provider request, sample or retry reset."""
import copy
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911')
PATCH=ROOT/'diagnostics-20260912'
spec=importlib.util.spec_from_file_location('release',ROOT/'deploy-enrichment-pilot20-20260911.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
FILES=('strict-lid-capture-pipeline.js','strict-lid-multi-extract.js')
KIND='diagnostics'
SOURCE_ARCHIVE='diagnostic-source.tar'
REVISION='diagnostic-revision.private.json'


def configure(kind):
    global PATCH,FILES,KIND,SOURCE_ARCHIVE,REVISION
    d.require(kind=='duration-fix','unknown_patch_kind')
    KIND=kind;PATCH=ROOT/'duration-fix-20260912'
    FILES=('strict-lid-capture-pipeline.js','strict-lid-capture-store.js')
    SOURCE_ARCHIVE='duration-fix-source.tar';REVISION='duration-revision.private.json'


def paused():
    marker=d.pilot.private(d.pilot.ROOT/'process20.private.json');proc=pathlib.Path('/proc')/str(marker['pid'])
    if proc.exists():d.require((proc/'stat').read_text().rsplit(')',1)[1].split()[19]!=marker['startTicks'],'pilot_operator_still_alive')
    d.require(not (ROOT/'pilot-closed.private.json').exists(),'pilot_already_closed')
    plan=d.saved('plan.private.json')
    d.require(d.prior.crons()==[{**j,'active':False} for j in plan['crons']],'pilot_crons_changed')
    d.require(plan['gate']['expiresAt'] and not d.gw.health()['languageEnrichmentPilot']['expired'],'pilot_expired')
    d.invariant(plan)
    return plan


def stage(commit):
    d.require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    plan=paused();d.verify_service(d.SERVICES[0],plan)
    d.require(not (PATCH/'revision.private.json').exists() and not (ROOT/REVISION).exists(),'diagnostic_already_staged')
    # A failed offline image build may resume only from these same two inputs.
    d.require(not PATCH.is_symlink(),'diagnostic_stage_symlink')
    PATCH.mkdir(mode=0o700,exist_ok=True);context=PATCH/'context'
    d.require(not context.is_symlink(),'diagnostic_context_symlink');context.mkdir(mode=0o700,exist_ok=True)
    d.require({p.name for p in PATCH.iterdir()}=={'context'} and
        {p.name for p in context.iterdir()}<=set(FILES)|{'Dockerfile'},'diagnostic_stage_foreign_file')
    allowed={'services/media-gateway/src/'+n:n for n in FILES}
    with tarfile.open(ROOT/SOURCE_ARCHIVE) as archive:
        members=[m for m in archive.getmembers() if not m.isdir()]
        d.require(len(members)==2 and {m.name for m in members}==set(allowed),'diagnostic_archive_scope')
        for member in members:
            d.require(member.isfile() and 0<member.size<180000,'diagnostic_archive_entry')
            target=context/allowed[member.name]
            content=archive.extractfile(member).read().replace(b'\r\n',b'\n')
            d.require(not target.is_symlink() and (not target.exists() or target.read_bytes()==content),'diagnostic_staged_source_drift')
            if not target.exists():target.write_bytes(content);target.chmod(0o600)
    after={**plan['sourceAfter'],**{n:d.sha((context/n).read_bytes()) for n in FILES}}
    d.require(all(after[n]!=plan['sourceAfter'][n] for n in FILES),'diagnostic_unchanged')
    current=d.gw.inspect(d.SERVICES[0]);image='norva-media-gateway:enrichment-pilot20-'+KIND+'-20260912'
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    base='norva-enrichment-pilot20-'+KIND+'-base:20260912'
    d.gw.run(['docker','tag',current['Image'],base])
    d.require(d.gw.image_identity(base)['index']==current['Image'],'diagnostic_base_drift')
    d.gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base,'-t',image,str(context)])
    for name in FILES:d.gw.run(['docker','run','--rm','--network','none','--read-only','--memory','512m','--cpus','1','--entrypoint','node',image,'--check','/app/src/'+name])
    revision={'originalPlanSha256':d.sha(d.artifact('plan.private.json')),'commit':commit,
        'image':image,'imageIdentity':d.gw.image_identity(image),'sourceAfter':after,'createdAt':d.stamp()}
    if KIND=='duration-fix':revision['parentDiagnosticSha256']=d.sha(d.artifact('diagnostic-revision.private.json'))
    d.gw.private_write(PATCH/'revision.private.json',revision)
    print(json.dumps({'diagnosticStaged':True,'modules':2,'providerRequests':0,'commit':commit}))


def deploy():
    plan=paused();d.idle();d.verify_service(d.SERVICES[0],plan)
    d.require(not (ROOT/REVISION).exists(),'diagnostic_already_deployed')
    buffer=d.gw.health()['languageCaptureBuffer']
    d.require(all(buffer[k]==0 for k in ('entries','bytes','reservations','computations')),'diagnostic_audio_pending')
    revision=json.loads((PATCH/'revision.private.json').read_text())
    changed=copy.deepcopy(plan)
    for key in ('image','imageIdentity','sourceAfter'):changed[key]=revision[key]
    original=d.gw.inspect(d.SERVICES[0]);expected=d.expected_container(changed,d.SERVICES[0])
    candidate_name='norva-media-gateway-pilot20-'+KIND+'-candidate'
    created=d.gw.docker_api('POST','/containers/create?name='+candidate_name,d.gw.clone_payload(expected,changed['image']))
    receipt={'candidateContainer':created['Id'],'candidateName':candidate_name}
    d.gw.private_write(PATCH/'intent.private.json',{'originalContainer':original,'receipt':receipt,'at':d.stamp()})
    d.gw.assert_clone(expected,d.gw.inspect(created['Id']),changed['image']);d.idle()
    try:
        d.gw.run(['docker','stop','--time','20',original['Id']])
        d.gw.run(['docker','rename',original['Id'],'norva-media-gateway-pilot20-before-'+KIND])
        d.gw.run(['docker','rename',created['Id'],d.SERVICES[0]]);d.gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:d.verify_service(d.SERVICES[0],changed);ready=True;break
            except Exception:time.sleep(1)
        d.require(ready,'diagnostic_gateway_unhealthy')
    except Exception:
        d.edge.restore(d.SERVICES[0],{'containers':{d.SERVICES[0]:original}},receipt)
        raise RuntimeError('diagnostic_failed_original_restored') from None
    d.save(REVISION,revision)
    d.invariant(plan)
    print(json.dumps({'diagnosticDeployed':True,'modules':2,'sampleFiles':20,'oldContainerRetained':True,
        'newProviderRequests':0,'thresholdsChanged':False,'commit':revision['commit']}))


if __name__=='__main__':
    os.umask(0o077)
    try:
        if sys.argv[-1]=='duration-fix':configure('duration-fix')
        if sys.argv[1]=='stage':stage(sys.argv[2])
        elif sys.argv[1]=='deploy':deploy()
        else:raise RuntimeError('unknown_phase')
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'diagnostic_release_failed'}));sys.exit(1)
