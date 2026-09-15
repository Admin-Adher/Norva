"""Explicit three-hour pause, unchanged six-file post-VOD release and idle gates.

A separate owned watchdog restores only the two recorded cron active bits.
It does not wait for media idleness, cancel work or extend the authorization.
Runtime recovery remains the existing retained-container guard's responsibility.
"""
import hashlib, importlib.util, json, math, os, pathlib, re, sys, time

BASE=pathlib.Path('/home/adrien/.norva')
ROOT=pathlib.Path(__file__).resolve().parent
ADAPTER=BASE/'unknown-first-language-edge-20260914/deploy-unknown-first-language-edge.py'
ADAPTER_SHA='0b6c11ae7b8b32832450045040800e5df183c62ead6d9d565718a9de137eaef9'
TIMING=BASE/'owned-language-maintenance-60m-20260914/deploy-owned-language-maintenance-60m-20260914.py'
TIMING_SHA='998ceb807f5f79be63a333e4101e335b64942c0b31eb4bb6141d09b1c81c9ea2'
POST_VOD=BASE/'post-vod-language-edge-20260914-20260914210725/deploy-post-vod-language-edge-20260914.py'
POST_VOD_SHA='41b1e69ffb9fc126ce4bdecf51aaf05c3aedd148d32f59b515c8954b71ffdc4b'
PAUSE_SECONDS=10800
RESTORE_MARGIN_SECONDS=90
ACK='pause-planned-jobs-at-most-3h-no-cancellation'
PROFILE='post-vod-3h'
ATTEMPT_PATTERN='post-vod-language-edge-3h-20260915-[0-9]{14}'
CRONS={84:'norva-dynamic-enrichment-fleet',159:'norva-playback-language-validation-worker'}

def require(ok,code):
    if not ok:raise RuntimeError(code)
def sha(data):return hashlib.sha256(data).hexdigest()
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
def pinned_post_vod():
    require(POST_VOD.is_file() and not POST_VOD.is_symlink() and sha(POST_VOD.read_bytes())==POST_VOD_SHA,'post_vod_helper_drift')
    return load('three_hour_post_vod_baseline',POST_VOD)

def validate_profile(cfg,adapter,post=None):
    require(cfg.get('profile')==PROFILE and cfg.get('maxPauseSeconds')==PAUSE_SECONDS
        and cfg.get('authorization')==ACK,'three_hour_authorization_binding')
    require(cfg.get('attemptDirectory')==ROOT.name,'attempt_directory_binding')
    adapter.validate(cfg)
    post=post or pinned_post_vod()
    require({name:pair[1] for name,pair in cfg['edgeFiles'].items()}==post.CANDIDATE,'reviewed_post_vod_payload_drift')

def validate_crons(plan):
    rows=plan.get('crons',[])
    require(len(rows)==2 and {row.get('id'):row.get('name') for row in rows}==CRONS
        and all(type(row.get('active')) is bool and re.fullmatch('[a-f0-9]{32}',str(row.get('spec',''))) for row in rows),
        'authorized_two_crons_only')

def validate_window(begin):
    require(begin.get('maxPauseSeconds')==PAUSE_SECONDS and begin.get('authorization')==ACK,'pause_window_binding')
    require(all(type(begin.get(k)) in (int,float) and math.isfinite(begin[k]) for k in ('at','deadline'))
        and begin['deadline']-begin['at']==PAUSE_SECONDS,'pause_deadline_not_renewable')

def await_pause_guard(base,begin):
    until=time.monotonic()+30
    while time.monotonic()<until:
        require(base.process_alive('pause-watch'),'pause_guard_missing')
        if (ROOT/'pause-ready.private.json').exists():
            ready=base.saved('pause-ready.private.json')
            require(ready.get('deadline')==begin['deadline'] and ready.get('cronIds')==sorted(CRONS)
                and type(ready.get('at')) in (int,float) and begin['at']<=ready['at']<=time.time(),
                'pause_guard_ready_binding')
            return
        time.sleep(.1)
    raise RuntimeError('pause_guard_not_ready')

def install_bounded_launch(base):
    def launch():
        plan=base.saved('plan.private.json');validate_crons(plan);base.invariant(plan)
        now=time.time()
        require(0<=now-plan['stagedAt']<300 and base.core.base.r.crons()==plan['crons'],'stage_expired_or_cron_drift')
        require(not any((ROOT/name).exists() for name in ('begin.private.json','closed.private.json','failed.private.json')),'prior_launch_no_retry')
        begin={'at':now,'deadline':now+PAUSE_SECONDS,'maxPauseSeconds':PAUSE_SECONDS,'authorization':ACK}
        base.save('begin.private.json',begin)
        # Neither scheduler can be paused until both independently identified
        # guards exist. The second guard has no media-operation capability.
        base.spawn('pause-watch');await_pause_guard(base,begin)
        base.spawn('watch');require(base.process_alive('watch'),'guard_missing')
        base.spawn('run')
        print(json.dumps({'launched':True,'guardAlive':True,'pauseGuardAlive':True,
            'maxPauseSeconds':PAUSE_SECONDS,'deadline':now+PAUSE_SECONDS,'jobCancellation':False}))
    base.launch=launch

def watch_pause(base):
    plan=base.saved('plan.private.json');begin=base.saved('begin.private.json')
    validate_crons(plan);validate_window(begin)
    base.invariant(plan)
    r=base.core.base.r
    base.save('pause-ready.private.json',{'at':time.time(),'deadline':begin['deadline'],'cronIds':sorted(CRONS)})
    # The SQL helper CAS-binds IDs, names, owners and all other cron fields via
    # spec, then restores only each recorded active bit in one transaction.
    # Its reads/writes have 20-second timeouts. Reserve 90 seconds before the
    # user's hard ceiling; a DB outage is recorded, never called an extension.
    while time.time()<begin['deadline']+120:
        closed=(ROOT/'closed.private.json').exists()
        due=time.time()>=begin['deadline']-RESTORE_MARGIN_SECONDS
        if closed or due:
            try:
                if r.crons()!=plan['crons']:r.alter_crons(plan,False)
                require(r.crons()==plan['crons'],'cron_restore_missing')
                at=time.time()
                base.save('pause-closed.private.json',{'at':at,'cronsRestored':True,
                    'deadline':begin['deadline'],'withinAuthorizedWindow':at<=begin['deadline'],
                    'runtimeClosed':closed,'jobCancellation':False})
                return
            except Exception:
                if not (ROOT/'pause-restore-error.private.json').exists():
                    base.save('pause-restore-error.private.json',{'at':time.time(),'code':'owned_cron_restore_requires_retry'})
        time.sleep(2)
    base.save('pause-requires-review.private.json',{'at':time.time(),'code':'cron_restore_not_confirmed',
        'deadline':begin['deadline'],'authorizationExtended':False})
    raise RuntimeError('cron_restore_not_confirmed')

def configure(adapter,timing):
    post=pinned_post_vod()
    adapter.ROOT=ROOT;adapter.__file__=str(pathlib.Path(__file__).resolve())
    adapter.BASE_HASHES={**adapter.BASE_HASHES,'norva-playback/index.ts':post.LIVE_PLAYBACK_SHA}
    adapter.HELPERS={**adapter.HELPERS,ADAPTER:ADAPTER_SHA,TIMING:TIMING_SHA,POST_VOD:POST_VOD_SHA}
    original_adapt=adapter.adapt
    def adapt(controller,cfg,sql,closer=None):
        validate_profile(cfg,adapter,post)
        result=original_adapt(controller,cfg,sql,closer);result.ACK=ACK
        original_stage=result.stage
        def stage():
            post.assert_vod_runtime(result)
            validate_crons({'crons':result.base.core.base.r.crons()})
            return original_stage()
        result.stage=stage
        original_initialize=result.initialize
        def initialize():
            original_initialize();install_bounded_launch(result.base)
        result.initialize=initialize
        return result
    adapter.adapt=adapt

def main():
    os.umask(0o077);sys.dont_write_bytecode=True
    require(ROOT.parent==BASE and re.fullmatch(ATTEMPT_PATTERN,ROOT.name),'scoped_fresh_attempt_directory_required')
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077==0,'private_root_required')
    require(pathlib.Path(__file__).resolve().parent==ROOT.resolve(),'operator_location_mismatch')
    require(len(sys.argv)>=2,'phase_required')
    for path,digest in ((ADAPTER,ADAPTER_SHA),(TIMING,TIMING_SHA),(POST_VOD,POST_VOD_SHA)):
        require(path.is_file() and not path.is_symlink() and sha(path.read_bytes())==digest,'pinned_operator_changed')
    adapter=load('three_hour_language_adapter',ADAPTER);timing=load('three_hour_legacy_timing',TIMING)
    configure(adapter,timing)
    cfg=adapter.read(ROOT,'release-config.private.json');validate_profile(cfg,adapter)
    if sys.argv[1]=='pause-watch':
        require(len(sys.argv)==2 and cfg.get('operatorSha256')==sha(pathlib.Path(__file__).read_bytes()),'pause_guard_binding')
        for path,digest in adapter.HELPERS.items():
            require(path.is_file() and not path.is_symlink() and sha(path.read_bytes())==digest,'audited_helper_drift')
        sql=adapter.load('three_hour_sql',adapter.SQL_ROOT/'deploy-unknown-first-language-pipeline.py')
        sys.path.insert(0,str(adapter.UPSTREAM))
        controller=adapter.load('three_hour_controller',adapter.UPSTREAM/'deploy-vod-language-audit-20260913.py')
        closer=adapter.load('three_hour_closer',adapter.UPSTREAM/'close-unactivated-edge-release.py')
        controller=adapter.adapt(controller,cfg,sql,closer);controller.configure();controller.initialize()
        watch_pause(controller.base)
    else:adapter.main()

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else type(error).__name__}))
        sys.exit(1)
