"""Recheck the finite legacy KI/II/AN cohort, never ban valid ISO languages.

One fresh header probe per exact file, using the existing production admission
and drain checks. No reset, quarantine change, forced language or new model.
The old map and operation intents stay private; an uncertain call is not retried.
An unchanged suspicious tag can enter the ordinary strict validator only with
a fresh, bound profile and no existing job, through its guarded production RPC.
"""
import collections,fcntl,hashlib,importlib.util,json,os,pathlib,re,sys,time

ROOT=pathlib.Path('/home/adrien/.norva/legacy-language-tags-20260913')
RELEASE=ROOT.parent/'provider-dubbed-release-20260913/deploy-provider-dubbed-20260913.py'
PILOT=ROOT.parent/'unknown-vod-pilot-20260911/run-unknown-vod-pilot-20260911.py'

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

release=load('legacy_tag_release',RELEASE)
pilot=load('legacy_tag_helpers',PILOT)
require,gw=release.require,release.gw

def save(name,value):gw.private_write(ROOT/name,value)
def saved(name):return json.loads(gw.safe_file(ROOT,name).read_text())

def is_suspect(tracks):
    # This is a support cohort selector, not a global validity/truth predicate.
    return isinstance(tracks,list) and any(isinstance(t,dict) and t.get('lang') in ('ki','ii','an') for t in tracks)

def prepare():
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'plan_not_fresh')
    require(release.saved('closed.private.json').get('updated') is True,'release_not_complete')
    rows=pilot.query("""WITH suspects AS MATERIALIZED (
 SELECT c.* FROM public.catalog_file_tracks c WHERE c.item_type='movie'
 AND (c.audio_tracks @> '[{"lang":"ki"}]' OR c.audio_tracks @> '[{"lang":"ii"}]' OR c.audio_tracks @> '[{"lang":"an"}]')
 AND c.audio_lang_verified_at IS NULL
 AND coalesce(c.audio_lang_verification,'{}'::jsonb)='{}'::jsonb
 AND coalesce(c.audio_whisper_verification,'{}'::jsonb)='{}'::jsonb
 AND c.audio_probed_at<'2026-09-13 00:00:00+00'::timestamptz
 AND (c.audio_lang_retry_at IS NULL OR c.audio_lang_retry_at<=now())
), eligible AS (
 SELECT DISTINCT ON(c.server_host,c.external_id) v.user_id,v.source_id,v.id AS variant_id,
 c.server_host AS identity_key,c.external_id,c.audio_tracks AS original_tracks,c.audio_probed_at AS original_probed_at
 FROM suspects c JOIN public.catalog_source_provider_identities i ON i.identity_id::text=c.server_host
 JOIN public.cloud_sources s ON s.id=i.source_id AND s.user_id=i.user_id AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
 JOIN public.admin_internal_accounts a ON a.user_id=s.user_id
 JOIN auth.users u ON u.id=s.user_id AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
 JOIN public.cloud_source_catalog_heads h ON h.source_id=s.id AND h.user_id=s.user_id
 JOIN public.cloud_title_variants v ON v.source_id=s.id AND v.user_id=s.user_id AND v.generation_id=h.active_generation_id
  AND v.item_type='movie' AND v.external_id=c.external_id
 WHERE NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs j WHERE j.identity_key=c.server_host AND j.item_type='movie' AND j.external_id=c.external_id)
 ORDER BY c.server_host,c.external_id,v.id
)
SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM eligible e;""")
    require(0<len(rows)<=18,'cohort_size_changed')
    for i,row in enumerate(rows,1):
        require(all(pilot.UUID.fullmatch(row[k]) for k in ('user_id','source_id','variant_id','identity_key')),'cohort_identity_invalid')
        require(is_suspect(row['original_tracks']),'cohort_tag_invalid');row['sample']=i
    files=[pathlib.Path(__file__),RELEASE,PILOT,PILOT.with_name('check-strict-lid-adaptive-evidence-batch-20260910.py')]
    plan={'rows':rows,'preparedAt':time.time(),'expiresAt':time.time()+3600,
        'releaseCommit':release.saved('plan.private.json')['commit'],
        'protected':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    save('plan.private.json',plan)
    print(json.dumps({'prepared':True,'files':len(rows),'providers':len({r['identity_key'] for r in rows}),'providerRequests':0}))

def guard():
    plan=saved('plan.private.json');require(time.time()<plan['expiresAt'],'plan_expired')
    for path,digest in plan['protected'].items():require(hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==digest,'operator_changed')
    release.base.invariant(release.saved('plan.private.json'));release.verify_sql()
    for name in release.base.SERVICES:release.base.verify_edge(release.saved('plan.private.json'),name,True)
    require(release.saved('closed.private.json').get('updated') is True,'release_not_complete')
    require(release.base.core.base.r.crons()==release.saved('plan.private.json')['crons'],'cron_drift')
    return plan

def decision(value):
    if not value:return 'source_changed'
    if value.get('job'):return 'existing_job_protected'
    if value.get('verified'):return 'verified_preserved'
    if value.get('probeCircuitRetryAt'):return 'provider_circuit_open'
    if value.get('retryAt') and pilot.datetime.datetime.fromisoformat(value['retryAt'].replace('Z','+00:00')).timestamp()>time.time():return 'retry_preserved'
    return None

def step(sample):
    plan=guard();require(1<=sample<=len(plan['rows']),'sample_invalid')
    row=plan['rows'][sample-1];require(row['sample']==sample,'sample_changed')
    name=str(sample).zfill(2)
    require(not (ROOT/(name+'-intent.private.json')).exists(),'prior_intent_protected')
    require(not any(ROOT.glob('*-failed.private.json')),'earlier_uncertain_operation')
    value=pilot.current(row);reason=decision(value)
    if reason:print(json.dumps({'sample':sample,'skipped':reason}));return
    if not pilot.controls():print(json.dumps({'sample':sample,'skipped':'runtime_controls'}));return
    require(value.get('tracks')==row['original_tracks'],'observation_already_changed')
    save(name+'-before.private.json',value)
    save(name+'-intent.private.json',{'at':time.time(),'operation':'fresh_profile_probe'})
    try:
        result=pilot.header_probe(row)
        save(name+'-probe.private.json',result)
        if result['persisted']!=1:
            save(name+'-closed.private.json',{'at':time.time(),'result':'deferred','diagnostic':result})
            print(json.dumps({'sample':sample,'result':'deferred',**result}));return
        after=pilot.current(row);require(after is not None,'source_changed_after_probe')
        save(name+'-after.private.json',after)
        changed=after.get('tracks')!=row['original_tracks']
        result_name='fresh_metadata'
        # Fresh declared languages are useful, not speech certificates. Preserve
        # them. Only still-suspicious/unknown maps need the strict existing method.
        if is_suspect(after.get('tracks')) or any(pilot.track_unknown(t) for t in after.get('tracks') or []):
            reason=decision(after)
            if reason:result_name=reason
            elif not pilot.profile_ready(after):result_name='profile_incomplete'
            else:
                save(name+'-enqueue-intent.private.json',{'at':time.time()})
                started=pilot.enqueue(row,after)
                save(name+'-enqueue.private.json',started)
                result_name='queued' if started.get('jobId') else 'enqueue_deferred'
        save(name+'-closed.private.json',{'at':time.time(),'result':result_name,'changed':changed})
        print(json.dumps({'sample':sample,'result':result_name,'changed':changed,'providerProbes':result['attempted']}))
    except Exception:
        save(name+'-failed.private.json',{'at':time.time(),'code':'operation_failed_or_uncertain'})
        raise RuntimeError('operation_failed_or_uncertain') from None

def status():
    plan=saved('plan.private.json');states=collections.Counter();languages=collections.Counter()
    for row in plan['rows']:
        name=str(row['sample']).zfill(2);value=pilot.current(row)
        path=ROOT/(name+'-closed.private.json')
        states[saved(path.name)['result'] if path.exists() else 'not_completed']+=1
        for track in (value or {}).get('tracks') or []:languages[str(track.get('lang') or 'und')]+=1
    print(json.dumps({'files':len(plan['rows']),'states':dict(states),'currentDeclaredTrackLanguages':dict(languages),'thresholdsChanged':False,'quarantinesChanged':False}))

if __name__=='__main__':
    os.umask(0o077)
    try:
        require(ROOT.is_dir() and not ROOT.is_symlink(),'root_missing')
        with (ROOT/'operator.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            action=sys.argv[1];require(action in ('prepare','step','status'),'invalid_action')
            step(int(sys.argv[2])) if action=='step' else globals()[action]()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}',code) else 'legacy_recheck_failed'}));sys.exit(1)
