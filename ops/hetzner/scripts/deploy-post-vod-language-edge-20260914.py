"""Six-file language release on the verified final VOD runtime.

Retains the reviewed idle, recovery and 60-minute authorization mechanisms.
No Gateway modification, media-job interruption, flag activation or SQL write.
"""
import hashlib, importlib.util, json, os, pathlib, re, subprocess, sys

ROOT=pathlib.Path('/home/adrien/.norva/post-vod-language-edge-20260914')
PREVIOUS=ROOT.parent/'unknown-first-language-edge-20260914'
ADAPTER=PREVIOUS/'deploy-unknown-first-language-edge.py'
ADAPTER_SHA='0b6c11ae7b8b32832450045040800e5df183c62ead6d9d565718a9de137eaef9'
TIMING=ROOT.parent/'owned-language-maintenance-60m-20260914/deploy-owned-language-maintenance-60m-20260914.py'
TIMING_SHA='998ceb807f5f79be63a333e4101e335b64942c0b31eb4bb6141d09b1c81c9ea2'
ACK='pause-planned-jobs-at-most-60m-no-cancellation'
LIVE_PLAYBACK_SHA='c4d9d9a046ecf15f5ba9fbfd331c8bab092df143814503f235906364977cd589'
LIVE_TREE_SHA='3cfc9944b7eeb48eecf91b0a88150ef64ed46b56e9fb3f14635b2af035695aec'
EDGE_IMAGE='sha256:2781daf92394db91f7e94129cc3d04ec474ad16a8fe64b3fbeef6e7d557ab120'
GATEWAY_IMAGE='sha256:1e6f1fea5097c8ca7d5ee5273a3bface1584a95a1a757bfbab1c99aa0f1d7f13'
GATEWAY_FILES={
 '/app/src/index.js':'276b62398c9740f7a46c8d34eeb340faf5173324b61c74b0fa5c8a083b15be5e',
 '/app/src/video-encoder.js':'9114c81904f0e67b7c0214a66f80c8f3956f6a90986a5de2b5ac26b729bbf7d2'}
CANDIDATE={
 '_shared/provider-catalog-language.mjs':'1569281e8be1bdfb9317717303ff6986f8d5347962185c9c5603174c6399094e',
 '_shared/selection-provider-languages.mjs':'ecd42be9adc48c2ff7e905201f8ff7819907df25750ae5cbf33ca14c61474cce',
 '_shared/xtream-language-declarations.mjs':'9b040c699dbc0ae708b36a6da645c1ff6008ff1f64395f1841c195012e17a7bc',
 '_shared/owned-provider-language-declarations.mjs':'210bb9feac4739bd13aeef3d58310f48da9c4723935e2d455bcdba820c68264a',
 'norva-catalog/index.ts':'00f7ead0a46c6e8061bb2dfb6abda53be1b8c4b5f09c0810cefc7f4c290d1e61',
 'norva-playback/index.ts':'f27d594f0ea27786f4f463c15783c1909fcd0cff9263476777af6b14263e95fc'}

def require(ok,code):
    if not ok:raise RuntimeError(code)
def sha(data):return hashlib.sha256(data).hexdigest()
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

def validate_profile(cfg,adapter):
    require(cfg.get('profile')=='post-vod' and cfg.get('maxPauseSeconds')==3600
        and cfg.get('authorization')==ACK,'post_vod_authorization_binding')
    adapter.validate(cfg)
    require({name:pair[1] for name,pair in cfg['edgeFiles'].items()}==CANDIDATE,'reviewed_post_vod_payload_drift')

def assert_vod_runtime(op):
    gw=op.gw.inspect()
    require(gw['Image']==GATEWAY_IMAGE and gw['Config']['Image']=='norva-media-gateway:vod-clock-20260914',
        'coordinated_gateway_image_changed')
    for path,digest in GATEWAY_FILES.items():
        result=subprocess.run(['docker','exec',gw['Id'],'sha256sum',path],text=True,capture_output=True,check=True,timeout=20)
        require(result.stdout.split()[0]==digest,'coordinated_gateway_file_changed')
    for name in op.base.SERVICES:
        current=op.gw.inspect(name)
        hashes=op.base.edge.hashes(op.base.lib.edge_root(current))
        require(current['Image']==EDGE_IMAGE and len(hashes)==160
            and hashes.get('norva-playback/index.ts')==LIVE_PLAYBACK_SHA
            and sha(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode())==LIVE_TREE_SHA,
            'coordinated_edge_baseline_changed')

def configure(adapter,timing):
    # One reviewed baseline file changed during VOD; the other five inputs and
    # the six-file scope remain those of the pinned adapter.
    adapter.ROOT=ROOT;adapter.__file__=str(pathlib.Path(__file__).resolve())
    adapter.BASE_HASHES={**adapter.BASE_HASHES,'norva-playback/index.ts':LIVE_PLAYBACK_SHA}
    adapter.HELPERS={**adapter.HELPERS,ADAPTER:ADAPTER_SHA,TIMING:TIMING_SHA}
    timing.ROOT=ROOT
    original_adapt=adapter.adapt
    def adapt(controller,cfg,sql,closer=None):
        validate_profile(cfg,adapter)
        result=original_adapt(controller,cfg,sql,closer)
        result.ACK=ACK
        original_stage=result.stage
        def stage():
            assert_vod_runtime(result)
            return original_stage()
        result.stage=stage
        original_initialize=result.initialize
        def initialize():
            original_initialize()
            timing.install_bounded_launch(result.base)
        result.initialize=initialize
        return result
    adapter.adapt=adapt

def main():
    os.umask(0o077);sys.dont_write_bytecode=True
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077==0,'private_root_required')
    require(pathlib.Path(__file__).resolve().parent==ROOT.resolve(),'operator_location_mismatch')
    for path,digest in ((ADAPTER,ADAPTER_SHA),(TIMING,TIMING_SHA)):
        require(path.is_file() and not path.is_symlink() and sha(path.read_bytes())==digest,'pinned_operator_changed')
    adapter=load('post_vod_language_adapter',ADAPTER)
    timing=load('post_vod_language_timing',TIMING)
    configure(adapter,timing)
    cfg=adapter.read(ROOT,'release-config.private.json')
    validate_profile(cfg,adapter)
    adapter.main()

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else type(error).__name__}))
        sys.exit(1)
