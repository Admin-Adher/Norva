"""Six-file Edge rollout using the existing pinned idle/drain/recovery guard.

No SQL writes, provider requests, switch activation or whole-repository copy.
bind-sql records a read-only prerequisite; stage/launch/run/watch/recover/status
delegate to the audited retained-container operator without relaxing its gates.
"""
import hashlib, importlib.util, json, os, pathlib, re, sys

ROOT = pathlib.Path('/home/adrien/.norva/unknown-first-language-edge-20260914')
UPSTREAM = ROOT.parent / 'autonomous-language-release-20260914'
SQL_ROOT = ROOT.parent / 'unknown-first-language-pipeline-20260914'
SQL_COMMIT = 'ff8a25ead75088ff83eea216c94c54c3efab1e18'
LEGACY_COMMIT = 'e99e32c0be872bff6bcc66f525cfa3fdd5e3127a'
HELPERS = {
    UPSTREAM/'deploy-vod-language-audit-20260913.py': '4637d735583017f01cb2dff028ee9c2452cc00a28aab35669875d7d0536fbf2d',
    UPSTREAM/'release_binding.py': '80de48d156863ad2da8922f331955c837f791568464164800d365e879879a1fa',
    UPSTREAM/'close-unactivated-edge-release.py': '3d2b933ebcad1521f8b841582c43aa2bc2f1001f4e9fc93ae465257d72ee7539',
    SQL_ROOT/'deploy-unknown-first-language-pipeline.py': 'be293c9b1ccdf4cf06a0e49e308eff45eea39a898383031e67403d3080865a6d',
}
BASE_HASHES = {
    '_shared/provider-catalog-language.mjs': 'a1decb43db87f9dec85db770eab0b47096d838d8535d91a16ebbbf6b8825d39e',
    '_shared/selection-provider-languages.mjs': '22f596f37f74375e7413adb09b6f8b12be7e468ea3fc0d428c8f0221d20ea152',
    '_shared/xtream-language-declarations.mjs': '724cb343e077fa037c906d237b77ff7e5cd46bf6d2603284c0ae7c2f7538a316',
    '_shared/owned-provider-language-declarations.mjs': None,
    'norva-catalog/index.ts': '6f209a4ddfc94fdda2e180a6bc63f61334a05b177a080a38f84e2d53e212425f',
    'norva-playback/index.ts': '2d661fdb6a71f85bf1e654e74d61ac1c128efb2801a5339883abed62254f3b46',
}
LIMITS = {'_shared/provider-catalog-language.mjs':32768,
    '_shared/selection-provider-languages.mjs':12288, '_shared/xtream-language-declarations.mjs':12288,
    '_shared/owned-provider-language-declarations.mjs':8192,
    'norva-catalog/index.ts':327680, 'norva-playback/index.ts':1048576}
LEGACY_SIGNATURES = (
    'catalog_provider_language_alias(text)', 'catalog_provider_language(jsonb,text,text)',
    'cloud_catalog_reconcile_provider_language_hints(uuid,uuid,integer)',
    'cloud_catalog_selection_series_episode_audio_evidence(uuid,uuid)',
    'cloud_catalog_selection_series_observed_audio_languages(uuid,uuid)',
    'cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid)',
    'hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)',
)
EXTRA_SIGNATURES = LEGACY_SIGNATURES + (
    'catalog_provider_stream_audio_languages(jsonb)',
    'record_owned_movie_language_declaration(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb)',
    'capture_registered_episode_language_declarations(uuid,uuid,uuid,bigint,bigint,text,jsonb)',
    'catalog_movie_audio_identified(uuid,uuid,uuid)',
    'cloud_catalog_effective_audio_languages_before_owned(uuid,text,uuid,text)',
)

def require(ok, code):
    if not ok: raise RuntimeError(code)
def sha(data): return hashlib.sha256(data).hexdigest()
def read(root, name):
    path=root/name
    require(path.is_file() and not path.is_symlink(), 'private_evidence_missing')
    return json.loads(path.read_text())
def validate(cfg):
    require(cfg.get('schema')==1 and cfg.get('sqlCommit')==SQL_COMMIT, 'release_binding_invalid')
    require(re.fullmatch('[a-f0-9]{40}',str(cfg.get('commit',''))), 'commit_invalid')
    require(set(cfg.get('edgeFiles',{}))==set(BASE_HASHES), 'edge_scope')
    for name, before in BASE_HASHES.items():
        pair=cfg['edgeFiles'][name]
        require(isinstance(pair,list) and len(pair)==2 and pair[0]==before, 'audited_baseline_mismatch')
        require(isinstance(pair[1],str) and re.fullmatch('[a-f0-9]{64}',pair[1]) and pair[1]!=before, 'candidate_hash_invalid')
    return cfg
def load(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module

def sql_snapshot(sql):
    require(sql.bind()['commit']==SQL_COMMIT, 'sql_release_commit_drift')
    installed=read(SQL_ROOT,'sql-applied.private.json')
    functions=sql.definitions()
    require(installed['commit']==SQL_COMMIT and functions==installed['functions'], 'installed_sql_drift')
    require(sql.state()['metadataEnabled'] is False, 'metadata_switch_must_remain_off')
    names=','.join("'public."+name+"'" for name in EXTRA_SIGNATURES)
    extra=json.loads(sql.query("""select jsonb_agg(jsonb_build_object(
      'signature',p.oid::regprocedure::text,'hash',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,
      'private',not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE'))
      order by p.oid::regprocedure::text) from pg_proc p where p.oid in
      (select to_regprocedure(x) from unnest(array["""+names+"]) x);"))
    require(len(extra)==len(EXTRA_SIGNATURES) and all(row['private'] for row in extra), 'private_sql_scope')
    legacy=read(UPSTREAM,'sql-proof.private.json')
    require(legacy.get('verified') is True and legacy.get('commit')==LEGACY_COMMIT,'legacy_sql_proof_binding')
    expected={row['signature'].removeprefix('public.'):row['sha256'] for row in legacy['functions']
        if row['signature'].removeprefix('public.') in LEGACY_SIGNATURES}
    actual={row['signature'].removeprefix('public.'):row['hash'] for row in extra
        if row['signature'].removeprefix('public.') in LEGACY_SIGNATURES}
    require(set(expected)==set(LEGACY_SIGNATURES) and expected==actual,'legacy_supplier_sql_drift')
    surface=json.loads(sql.query("""select jsonb_build_object(
      'tablePrivate',not has_table_privilege('anon','public.catalog_owned_language_declarations','SELECT')
        and not has_table_privilege('authenticated','public.catalog_owned_language_declarations','SELECT')
        and not has_table_privilege('service_role','public.catalog_owned_language_declarations','INSERT')
        and has_table_privilege('service_role','public.catalog_owned_language_declarations','SELECT'),
      'viewPrivate',not has_table_privilege('anon','public.cloud_catalog_owned_audio_declarations','SELECT')
        and not has_table_privilege('authenticated','public.cloud_catalog_owned_audio_declarations','SELECT'),
      'rls',(select relrowsecurity from pg_class where oid='public.catalog_owned_language_declarations'::regclass),
      'viewOptions',(select reloptions from pg_class where oid='public.cloud_catalog_owned_audio_declarations'::regclass),
      'viewHash',encode(sha256(convert_to(pg_get_viewdef('public.cloud_catalog_owned_audio_declarations'::regclass,true),'UTF8')),'hex'));
    """))
    require(surface['tablePrivate'] and surface['viewPrivate'] and surface['rls']
        and surface['viewOptions']==['security_invoker=true'], 'private_projection_scope')
    return {'functions':functions,'extra':extra,'surface':surface}

def adapt(controller, cfg, sql, closer=None):
    """Retain the upstream implementation; change only binding and import checks."""
    validate(cfg)
    controller.ROOT=ROOT; controller.__file__=str(pathlib.Path(__file__).resolve())
    controller.SUFFIX=ROOT.name
    controller.ACK='activate-only-owned-language-edge-six-files'
    controller.FILE_LIMITS=LIMITS
    controller.ADDED_FILES=frozenset(name for name,digest in BASE_HASHES.items() if digest is None)
    controller.MAX_ARCHIVE_BYTES=sum(LIMITS.values())+128*1024
    def configure():
        current=validate(read(ROOT,'release-config.private.json'))
        require(current==cfg,'release_binding_drift')
        controller.COMMIT=cfg['commit'];controller.FILES=cfg['edgeFiles'];controller.validate_files()
    controller.configure=configure
    def proof():
        row=read(ROOT,'sql-proof.private.json')
        require(row.get('commit')==cfg['commit'] and row.get('sqlCommit')==SQL_COMMIT, 'sql_proof_binding')
        return row['snapshot']
    controller.read_proof=proof
    def verify(): require(sql_snapshot(sql)==proof(), 'sql_prerequisite_drift')
    controller.verify_sql=verify
    original_initialize=controller.initialize
    def initialize():
        original_initialize()
        controller.dependencies=sorted(set(controller.dependencies)|set(HELPERS)|{
            UPSTREAM/'sql-proof.private.json',
            SQL_ROOT/'release-manifest.private.json',SQL_ROOT/'sql-applied.private.json',
            *[SQL_ROOT/name for name in sql.MIGRATIONS]})
    controller.initialize=initialize
    original_import_health=controller.import_health
    def import_health(container):
        original_import_health(container)
        ip=container['NetworkSettings']['Networks']['norva_default']['IPAddress']
        request=controller.urllib.request.Request('http://'+ip+':9000/norva-playback',method='OPTIONS',headers={'Origin':'https://norva.tv'})
        with controller.urllib.request.urlopen(request,timeout=5) as response:
            require(response.status in (200,204),'playback_module_import_failed')
    controller.import_health=import_health
    if closer is not None:
        original_recover=controller.recover
        def recover(plan):
            # No restart/idle bypass: the pinned closer proves both original
            # replicas, absence of candidate containers and a dead failed runner.
            # It restores only the cron bits when the drain never activated Edge.
            if (controller.ROOT/'failed.private.json').is_file() and all(
                not (controller.ROOT/(name+'-receipt.private.json')).exists() for name in controller.base.SERVICES):
                require(plan.get('commit')==cfg['commit'],'recovery_commit_drift')
                return closer.close(controller)
            return original_recover(plan)
        controller.recover=recover
    return controller

def main():
    os.umask(0o077);sys.dont_write_bytecode=True
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077==0,'private_root_required')
    require(pathlib.Path(__file__).resolve().parent==ROOT.resolve(),'operator_location_mismatch')
    require(len(sys.argv)>=2 and sys.argv[1] in ('bind-sql','stage','launch','run','watch','recover','status'),'invalid_phase')
    cfg=validate(read(ROOT,'release-config.private.json'))
    require(cfg.get('operatorSha256')==sha(pathlib.Path(__file__).read_bytes()),'operator_binding_drift')
    for path,digest in HELPERS.items():
        require(path.is_file() and not path.is_symlink() and sha(path.read_bytes())==digest,'audited_helper_drift')
    sql=load('owned_edge_sql_prerequisites',SQL_ROOT/'deploy-unknown-first-language-pipeline.py')
    if sys.argv[1]=='bind-sql':
        value={'commit':cfg['commit'],'sqlCommit':SQL_COMMIT,'snapshot':sql_snapshot(sql)}
        with (ROOT/'sql-proof.private.json').open('x') as file: json.dump(value,file,indent=2)
        print(json.dumps({'sqlBound':True,'productionWrites':0,'providerRequests':0}));return
    sys.path.insert(0,str(UPSTREAM))
    controller=load('owned_language_retained_edge',UPSTREAM/'deploy-vod-language-audit-20260913.py')
    closer=load('owned_language_unactivated_closer',UPSTREAM/'close-unactivated-edge-release.py')
    adapt(controller,cfg,sql,closer).main()

if __name__=='__main__':
    try: main()
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else type(error).__name__}))
        sys.exit(1)
