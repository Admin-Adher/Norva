"""One Gateway module; preserve current Edge, provider controls and all other work."""
import importlib.util,json,os,pathlib,re,sys,tarfile,time
ROOT=pathlib.Path('/home/adrien/.norva/mkv-audio-alignment-20260912')
NATIVE=ROOT.parent/'mkv-audio-native-20260912-r2/native-proof.json'
FILES=('index.js',)
IMAGE='norva-media-gateway:mkv-audio-alignment-20260912'
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
current=load('mkv_audio_current',ROOT.parent/'observed-ts-relay-20260912/deploy-observed-ts-relay-20260912.py')
op=load('mkv_audio_supervisor',ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT,op.NATIVE,op.FILES,op.IMAGE=ROOT,NATIVE,FILES,IMAGE
op.PREFIX=op.SERVICE+'-mkv-audio-alignment-20260912';op.__file__=__file__
gw,require=op.gw,op.require
source_snapshot=current.live.source_snapshot
def invariant(plan):
    op.base.previous.invariant(op.base.previous.saved('plan.private.json'))
    require(op.base.r.controls()==plan['controls'],'controls_changed')
    for name,digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(name).read_bytes())==digest,'protected_evidence_changed')
    for name in current.EDGES:current.verify_edge(name,current.op.saved('plan.private.json'),True)
    for name,identity in plan['otherContainers'].items():
        require(gw.inspect(name)['Id']==identity,'unrelated_container_changed')
def verify_gateway(plan,candidate):
    active=gw.inspect(op.SERVICE)
    expected=op.saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(active['Id']==expected,'gateway_container_not_owned')
    gw.assert_clone(plan['original'],active,IMAGE if candidate else plan['original']['Config']['Image'])
    gw.assert_container_image(active,plan['imageIdentity' if candidate else 'originalImageIdentity'])
    require(source_snapshot()==plan['after' if candidate else 'before'],'gateway_source_changed')
    require(gw.binary_snapshot()==plan['binaries'],'runtime_binary_changed')
    health=gw.health();gw.assert_runtime(health,plan['runtime'])
    fence=health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode')=='disabled' and fence.get('files')==0
        and fence.get('passiveSources')==0,'dormant_admission_changed')
    require(active['State']['Running'] and active['RestartCount']==0 and not active['State']['OOMKilled'],'gateway_unhealthy')
def stage():
    commit=sys.argv[2];require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
    current.verify();original=gw.inspect(op.SERVICE);gw.assert_image_backed_runtime(original)
    proof=json.loads(NATIVE.read_text())
    require(proof.get('exitCode')==0 and proof.get('counts')=={'tests':2,'pass':2,'fail':0,'skipped':0}
        and proof.get('networkDisabled') is True and proof.get('newProviderRequests')==0
        and proof.get('image')==original['Image'],'native_proof_mismatch')
    context=ROOT/'context';context.mkdir(mode=0o700)
    expected={'services/media-gateway/src/index.js':'index.js'}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries=[x for x in archive.getmembers() if not x.isdir()]
        require(len(entries)==1 and {x.name for x in entries}==set(expected),'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0<entry.size<2000000,'archive_entry')
            data=archive.extractfile(entry).read().replace(b'\r\n',b'\n')
            require(gw.sha(data)==proof['sourceHashes'][entry.name],'native_source_drift')
            target=context/expected[entry.name];target.write_bytes(data);target.chmod(0o600)
    before=source_snapshot();after={**before,'index.js':gw.sha((context/'index.js').read_bytes())}
    tag='norva-mkv-audio-alignment-base:20260912';gw.run(['docker','tag',original['Image'],tag])
    require(gw.image_identity(tag)['index']==original['Image'],'build_base_drift')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY --chmod=0644 index.js /app/src/index.js\n')
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+tag,'-t',IMAGE,str(context)])
    gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--entrypoint','node',IMAGE,'--check','/app/src/index.js'])
    current.verify();parent=current.op.saved('plan.private.json')
    paths=[pathlib.Path(n) for n in parent['protectedFiles']]
    paths += [current.ROOT/n for n in ('plan.private.json','closed.private.json')]
    paths += [NATIVE,pathlib.Path(__file__),ROOT/'source.tar']
    plan={'commit':commit,'original':original,'before':before,'after':after,
        'originalImageIdentity':gw.image_identity(original['Image']),'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(),'runtime':gw.runtime_snapshot(gw.health()),
        'crons':op.base.r.crons(),'controls':op.base.r.controls(),
        'otherContainers':{name:gw.inspect(name)['Id'] for name in (*current.EDGES,op.base.previous.d.SERVICES[3])},
        'protectedFiles':{str(p):gw.sha(p.read_bytes()) for p in paths},'stagedAt':time.time()}
    op.save('plan.private.json',plan);invariant(plan);verify_gateway(plan,False)
    print(json.dumps({'staged':True,'productionUnchanged':True,'gatewayModules':1,'edgeFiles':0,'newProviderRequests':0}))
op.invariant,op.verify_gateway=invariant,verify_gateway
if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1];require(phase in ('stage','launch','run','watch','recover','verify'),'invalid_phase')
        stage() if phase=='stage' else getattr(op,phase)()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'mkv_audio_alignment_release_failed'}),flush=True);sys.exit(1)
