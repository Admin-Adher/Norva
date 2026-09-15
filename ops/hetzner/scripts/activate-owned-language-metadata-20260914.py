"""Enable only owned stream metadata after the post-VOD retained Edge rollout.

No catalogue rewrite, queue reset, provider call, deployment or cron mutation.
Preflight binds healthy replicas, private SQL, the public UI and the exact flag
row. Rehearsal rolls back; enable is one compare-and-swap transaction. A lost
response is resolved from our unique audit marker, never by a blind second write.
"""
import copy, hashlib, importlib.util, json, os, pathlib, re, sys, time, urllib.request, uuid

BASE=pathlib.Path('/home/adrien/.norva')
ROOT=pathlib.Path(__file__).resolve().parent
WRAPPER_SHA='41b1e69ffb9fc126ce4bdecf51aaf05c3aedd148d32f59b515c8954b71ffdc4b'
WRAPPER_3H_SHA='2ef0410daf9938d5f278dd063f13b5844c62fef6ad0dcd8b4de0b3acd941fdd6'
FLAG='owned_provider_language_metadata_enabled'
ACK='enable-only-owned-provider-language-metadata'
ROLLBACK_ACK='disable-only-our-owned-provider-language-metadata'
UI_PATH='/js/utils/mediaUtils.js?v=a87d07bf87'
UI_SHA='a87d07bf87da878d125206442724adfc971dcb47710f81ef0c6c07e0b5210c24'

def require(ok,code):
    if not ok: raise RuntimeError(code)
def sha(data): return hashlib.sha256(data).hexdigest()
def literal(value): return "'"+str(value).replace("'","''")+"'"
def read(root,name):
    file=root/name
    require(file.is_file() and not file.is_symlink(),'evidence_missing')
    return json.loads(file.read_text())
def save(name,value):
    with (ROOT/name).open('x') as file: json.dump(value,file,indent=2)
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module

def release_wrapper(binding):
    profile=binding.get('edgeProfile','post-vod')
    allowed={
        'post-vod':('post-vod-language-edge-20260914-[0-9]{14}','deploy-post-vod-language-edge-20260914.py',WRAPPER_SHA),
        'post-vod-3h':('post-vod-language-edge-3h-20260915-[0-9]{14}','deploy-owned-language-maintenance-3h-20260915.py',WRAPPER_3H_SHA),
    }
    require(profile in allowed,'scoped_edge_profile_required')
    pattern,filename,digest=allowed[profile]
    require(re.fullmatch(pattern,str(binding.get('edgeAttemptDirectory',''))),'scoped_edge_attempt_required')
    return filename,digest

def initialize(binding):
    filename,wrapper_sha=release_wrapper(binding)
    retry=BASE/binding['edgeAttemptDirectory']
    wrapper_file=retry/filename
    require(retry.is_dir() and not retry.is_symlink() and retry.stat().st_mode&0o077==0,'private_edge_attempt_required')
    require(wrapper_file.is_file() and not wrapper_file.is_symlink() and sha(wrapper_file.read_bytes())==wrapper_sha,'retry_operator_drift')
    wrapper=load('owned_activation_retry',wrapper_file)
    for path,digest in ((wrapper.ADAPTER,wrapper.ADAPTER_SHA),(wrapper.TIMING,wrapper.TIMING_SHA)):
        require(path.is_file() and not path.is_symlink() and sha(path.read_bytes())==digest,'pinned_post_vod_helper_drift')
    adapter=load('owned_activation_adapter',wrapper.ADAPTER)
    timing=load('owned_activation_timing',wrapper.TIMING)
    wrapper.configure(adapter,timing)
    cfg=adapter.validate(adapter.read(retry,'release-config.private.json'))
    wrapper.validate_profile(cfg,adapter)
    require(re.fullmatch('[a-f0-9]{40}',str(binding.get('edgeCommit','')))
        and cfg['commit']==binding['edgeCommit'] and cfg.get('operatorSha256')==wrapper_sha
        and cfg.get('profile')==binding.get('edgeProfile','post-vod'),'edge_binding_drift')
    for path,digest in adapter.HELPERS.items():
        require(path.is_file() and not path.is_symlink() and sha(path.read_bytes())==digest,'pinned_helper_drift')
    sql=adapter.load('owned_activation_sql',adapter.SQL_ROOT/'deploy-unknown-first-language-pipeline.py')
    sys.path.insert(0,str(adapter.UPSTREAM))
    controller=adapter.load('owned_activation_controller',adapter.UPSTREAM/'deploy-vod-language-audit-20260913.py')
    closer=adapter.load('owned_activation_closer',adapter.UPSTREAM/'close-unactivated-edge-release.py')
    controller=adapter.adapt(controller,cfg,sql,closer)
    controller.configure();controller.initialize()
    return controller,sql,adapter

def schema_query(adapter,sql):
    signatures=sorted(set(adapter.EXTRA_SIGNATURES)|set(sql.SIGNATURES)|{'feature_flag(text)'})
    names=','.join(literal('public.'+name) for name in signatures)
    # Covers definitions, owners, execution ACLs/search_path, RLS and view ACLs,
    # view contents and declaration constraints, independently of the flag value.
    return """select encode(sha256(convert_to(jsonb_build_object(
      'functions',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,
        'body',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig)
        order by p.oid::regprocedure::text) from pg_proc p where p.oid in
        (select to_regprocedure(n) from unnest(array["""+names+"""])n)),
      'relations',(select jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,
        'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
        'options',c.reloptions,'view',case when c.relkind='v' then pg_get_viewdef(c.oid,true) end)
        order by c.oid::regclass::text) from pg_class c where c.oid in
        ('public.catalog_owned_language_declarations'::regclass,'public.cloud_catalog_owned_audio_declarations'::regclass)),
      'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'body',pg_get_constraintdef(oid,true),
        'validated',convalidated) order by conname) from pg_constraint
        where conrelid='public.catalog_owned_language_declarations'::regclass),
      'policies',(select jsonb_agg(jsonb_build_object('name',polname,'roles',polroles,'command',polcmd,
        'permissive',polpermissive,'using',pg_get_expr(polqual,polrelid),
        'check',pg_get_expr(polwithcheck,polrelid)) order by polname)
        from pg_policy where polrelid='public.catalog_owned_language_declarations'::regclass)
      )::text,'UTF8')),'hex')"""

def fingerprint(sql,query):
    value=sql.query(query+';')
    require(re.fullmatch('[a-f0-9]{64}',value),'schema_fingerprint_missing')
    return value

def flag_row(sql):
    row=json.loads(sql.query("""select jsonb_build_object('enabled',enabled,'xmin',xmin::text,
      'updatedAt',updated_at,'updatedBy',updated_by) from public.admin_feature_flags where key="""+literal(FLAG)+';'))
    require(type(row.get('enabled')) is bool and re.fullmatch('[0-9]+',str(row.get('xmin',''))),'flag_row_invalid')
    return row

def verified_plan(controller,enabled):
    base=controller.base
    closed=base.saved('closed.private.json')
    require(closed.get('commit')==controller.COMMIT and closed.get('updated') is True
        and closed.get('cronsRestored') is True and closed.get('sqlVerified') is True,'successful_edge_rollout_required')
    require(not any(base.process_alive(phase) for phase in ('run','watch','pause-watch')),'rollout_still_active')
    plan=base.saved('plan.private.json')
    require(plan['commit']==controller.COMMIT and plan['controls']['flags'].get(FLAG) is False,'original_flag_binding_invalid')
    expected=copy.deepcopy(plan)
    expected['controls']['flags'][FLAG]=enabled
    base.invariant(expected)
    require(base.core.base.r.crons()==plan['crons'],'crons_not_restored')
    for name in base.SERVICES:
        base.verify_edge(plan,name,True)
        controller.import_health(controller.gw.inspect(name))
    return plan

def live_ui():
    def fetch(path):
        request=urllib.request.Request('https://norva.tv'+path,headers={
            'Cache-Control':'no-cache','User-Agent':'Norva-Release-Verification/1.0'})
        with urllib.request.urlopen(request,timeout=20) as response:
            require(response.status==200 and response.url.startswith('https://norva.tv/'),'ui_response_invalid')
            data=response.read(4*1024*1024+1)
            require(len(data)<=4*1024*1024,'ui_response_too_large')
            return data
    page=fetch('/app')
    require(('src="'+UI_PATH+'"').encode() in page,'public_ui_reference_drift')
    require(sha(fetch(UI_PATH))==UI_SHA,'public_ui_bytes_drift')
    return {'at':time.time(),'path':UI_PATH,'sha256':UI_SHA,'pageStatus':200,'assetStatus':200}

def validate_proof(proof,operator_sha,edge_commit):
    require(proof.get('sourceCommit')==edge_commit and proof.get('operatorSha256')==operator_sha,'activation_proof_binding')
    require(re.fullmatch('owned-language:[a-f0-9]{32}',str(proof.get('marker',''))),'activation_marker_invalid')
    require(re.fullmatch('[a-f0-9]{64}',str(proof.get('schemaSha256',''))),'schema_binding_invalid')
    require(proof.get('flag',{}).get('enabled') is False
        and re.fullmatch('[0-9]+',str(proof['flag'].get('xmin',''))),'original_flag_row_required')
    require(isinstance(proof.get('flags'),dict) and proof['flags'].get(FLAG) is False
        and all(type(value) is bool for value in proof['flags'].values()),'original_flag_set_required')

def transaction(proof,query,commit,rollback_row=None):
    before=rollback_row is not None
    row=rollback_row if before else proof['flag']
    require(not before or activation_owned(row,proof),'rollback_requires_our_marker')
    require(re.fullmatch('[0-9]+',str(row.get('xmin',''))),'transaction_row_binding_invalid')
    expected_flags={**proof['flags'],FLAG:before}
    flags=json.dumps(expected_flags,sort_keys=True,separators=(',',':'))
    marker=proof['marker']+(':rollback' if before else '')
    return ("""BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
      LOCK TABLE public.admin_feature_flags IN SHARE ROW EXCLUSIVE MODE;
      DO $guard$ BEGIN
        IF (select jsonb_object_agg(key,enabled) from public.admin_feature_flags)
          IS DISTINCT FROM """+literal(flags)+"""::jsonb THEN RAISE EXCEPTION 'flag set drift'; END IF;
        IF ("""+query+""") IS DISTINCT FROM """+literal(proof['schemaSha256'])+"""
          THEN RAISE EXCEPTION 'schema drift'; END IF;
        IF NOT EXISTS(select 1 from public.admin_feature_flags where key="""+literal(FLAG)+
        ' and enabled='+str(before).lower()+' and xmin::text='+literal(row['xmin'])+
        (' and updated_by='+literal(proof['marker']) if before else '')+"""
          ) THEN RAISE EXCEPTION 'owned flag row drift'; END IF;
      END $guard$;
      UPDATE public.admin_feature_flags SET enabled="""+str(not before).lower()+""",updated_at=clock_timestamp(),updated_by="""+
        literal(marker)+' WHERE key='+literal(FLAG)+""";
      SELECT jsonb_build_object('enabled',enabled,'xmin',xmin::text,'updatedAt',updated_at,'updatedBy',updated_by)
        FROM public.admin_feature_flags WHERE key="""+literal(FLAG)+'; '+('COMMIT;' if commit else 'ROLLBACK;'))

def activation_owned(row,proof):
    return row.get('enabled') is True and row.get('updatedBy')==proof['marker']

def main():
    os.umask(0o077);sys.dont_write_bytecode=True
    require(ROOT.parent==BASE and re.fullmatch('post-vod-owned-language-activation-20260914-[0-9]{14}',ROOT.name),
        'scoped_activation_directory_required')
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077==0,'private_root_required')
    require(pathlib.Path(__file__).resolve().parent==ROOT.resolve(),'operator_location_mismatch')
    mode=sys.argv[1] if len(sys.argv)>1 else ''
    require(mode in ('preflight','rehearse','enable','status','rollback-owned'),'invalid_phase')
    expected_ack=[ACK] if mode=='enable' else [ROLLBACK_ACK] if mode=='rollback-owned' else []
    require(sys.argv[2:]==expected_ack,'explicit_flag_activation_ack_required')
    binding=read(ROOT,'operator-binding.private.json')
    require(binding.get('activationDirectory')==ROOT.name,'activation_directory_binding')
    operator_sha=sha(pathlib.Path(__file__).read_bytes())
    require(binding.get('operatorSha256')==operator_sha and re.fullmatch('[a-f0-9]{40}',str(binding.get('operatorCommit',''))),
        'git_operator_binding_required')
    controller,sql,adapter=initialize(binding)
    query=schema_query(adapter,sql)
    if mode=='preflight':
        plan=verified_plan(controller,False)
        controller.verify_only_sql(plan)
        row=flag_row(sql);require(row['enabled'] is False,'flag_not_disabled')
        proof={'at':time.time(),'sourceCommit':controller.COMMIT,'operatorCommit':binding['operatorCommit'],
            'operatorSha256':operator_sha,'marker':'owned-language:'+uuid.uuid4().hex,
            'schemaSha256':fingerprint(sql,query),'flags':plan['controls']['flags'],
            'flag':row,'publicUi':live_ui()}
        save('preflight.private.json',proof)
        print(json.dumps({'preflight':True,'replicas':2,'metadataEnabled':False,'publicUiVerified':True,'providerRequests':0}));return
    proof=read(ROOT,'preflight.private.json');validate_proof(proof,operator_sha,controller.COMMIT)
    row=flag_row(sql)
    if (ROOT/'rollback-intent.private.json').is_file():
        intent=read(ROOT,'rollback-intent.private.json')
        require(intent.get('marker')==proof['marker']+':rollback','rollback_intent_binding_drift')
        if row['enabled'] is False and row['updatedBy']==intent['marker']:
            require(mode in ('status','rollback-owned'),'owned_activation_already_rolled_back')
            require(json.loads(sql.query('select jsonb_object_agg(key,enabled) from public.admin_feature_flags;'))==proof['flags'],
                'rollback_flag_set_drift')
            if not (ROOT/'disabled.private.json').exists():save('disabled.private.json',{'at':time.time(),'row':row,'responseRecovered':True})
            print(json.dumps({'metadataEnabled':False,'ownedRollbackVerified':True,'providerRequests':0}));return
        raise RuntimeError('rollback_response_unresolved_read_state_no_retry')
    if mode=='rollback-owned':
        require(activation_owned(row,proof) and read(ROOT,'enable-intent.private.json')['marker']==proof['marker'],
            'rollback_requires_our_activation')
        save('rollback-intent.private.json',{'at':time.time(),'marker':proof['marker']+':rollback','row':row})
        changed=json.loads(sql.query(transaction(proof,query,True,rollback_row=row),True))
        require(changed['enabled'] is False and changed['updatedBy']==proof['marker']+':rollback'
            and flag_row(sql)==changed,'owned_rollback_not_verified')
        require(json.loads(sql.query('select jsonb_object_agg(key,enabled) from public.admin_feature_flags;'))==proof['flags'],
            'rollback_flag_set_drift')
        save('disabled.private.json',{'at':time.time(),'row':changed,'responseRecovered':False})
        print(json.dumps({'metadataEnabled':False,'ownedRollbackVerified':True,'providerRequests':0}));return
    if row['enabled']:
        require(mode in ('enable','status') and (ROOT/'enable-intent.private.json').is_file()
            and activation_owned(row,proof),'unowned_flag_activation')
        require(read(ROOT,'enable-intent.private.json')['marker']==proof['marker'],'intent_binding_drift')
        verified_plan(controller,True)
        require(fingerprint(sql,query)==proof['schemaSha256'],'schema_changed_after_activation')
        if not (ROOT/'enabled.private.json').exists():
            save('enabled.private.json',{'at':time.time(),'sourceCommit':controller.COMMIT,'row':row,'responseRecovered':True})
        else: require(read(ROOT,'enabled.private.json')['row']==row,'enabled_row_changed')
        print(json.dumps({'verified':True,'metadataEnabled':True,'replicas':2,'cronsRestored':True,
            'onlyOwnedFlagChanged':True,'providerRequestsByOperator':0}));return
    verified_plan(controller,False)
    require(fingerprint(sql,query)==proof['schemaSha256'] and row==proof['flag'],'disabled_baseline_changed')
    if mode=='status':
        print(json.dumps({'verified':True,'metadataEnabled':False,'providerRequests':0}));return
    require(0<=time.time()-proof['at']<=300,'preflight_expired')
    if mode=='rehearse':
        sql.query(transaction(proof,query,False),True)
        require(flag_row(sql)==proof['flag'],'rehearsal_rollback_failed')
        verified_plan(controller,False)
        save('rehearsed.private.json',{'marker':proof['marker'],'schemaSha256':proof['schemaSha256'],'rollbackVerified':True})
        print(json.dumps({'rehearsed':True,'rollbackVerified':True,'providerRequests':0}));return
    rehearsal=read(ROOT,'rehearsed.private.json')
    require(rehearsal=={'marker':proof['marker'],'schemaSha256':proof['schemaSha256'],'rollbackVerified':True},'rehearsal_binding_drift')
    require(not (ROOT/'enable-intent.private.json').exists(),'prior_attempt_read_status_before_retry')
    save('enable-intent.private.json',{'at':time.time(),'marker':proof['marker'],'onlyFlag':FLAG})
    changed=json.loads(sql.query(transaction(proof,query,True),True))
    require(activation_owned(changed,proof) and flag_row(sql)==changed,'flag_commit_not_verified')
    verified_plan(controller,True)
    require(fingerprint(sql,query)==proof['schemaSha256'],'schema_changed_after_activation')
    save('enabled.private.json',{'at':time.time(),'sourceCommit':controller.COMMIT,'row':changed,'responseRecovered':False})
    print(json.dumps({'enabled':True,'metadataEnabled':True,'replicas':2,'cronsRestored':True,
        'onlyOwnedFlagChanged':True,'providerRequestsByOperator':0}))

if __name__=='__main__':
    try: main()
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else type(error).__name__}))
        sys.exit(1)
