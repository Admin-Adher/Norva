"""One shared Edge parser plus derived SQL hints; no provider/audio/job writes.

Reuses the tested two-replica drain/recovery supervisor. Original replicas and
trees are retained. The forward-compatible hint function may remain installed
after a rollback; the projection backfill runs only after a verified release.
"""
import importlib.util,json,os,pathlib,re,shutil,sys,tarfile,time
ROOT=pathlib.Path('/home/adrien/.norva/provider-dubbed-release-20260913')
PROOF=ROOT.parent/'provider-dubbed-proof-20260913/proof.private.json'
MIGRATION='20260913102000_provider_dubbed_language_target.sql'
FILE='_shared/provider-catalog-language.mjs'
SUFFIX='provider-dubbed-20260913'
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
base=load('dubbed_release_supervisor',ROOT.parent/'scoped-capture-jobs-release-20260913/deploy-scoped-capture-jobs-20260913.py')
base.ROOT,base.__file__,base.FILE=ROOT,__file__,FILE
base.fleet.ROOT=ROOT
gw,require,save,saved=base.gw,base.require,base.save,base.saved
sql=base.fleet.sql
def definitions():
    return json.loads(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))),'[]'::jsonb) "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('catalog_provider_language','catalog_provider_dubbed_category');"))
def definition_map(rows):return {r['signature']:r['definition'] for r in rows}
def verify_sql():
    require(definition_map(definitions())==definition_map(json.loads(PROOF.read_text())['definitions']),'sql_parser_drift')
    require(sql("SELECT NOT has_function_privilege('anon','public.catalog_provider_dubbed_category(text)','EXECUTE') "
        "AND NOT has_function_privilege('authenticated','public.catalog_provider_dubbed_category(text)','EXECUTE') "
        "AND has_function_privilege('service_role','public.catalog_provider_dubbed_category(text)','EXECUTE') "
        "AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('public.catalog_provider_language(jsonb,text,text)'::regprocedure,"
        "'public.catalog_provider_dubbed_category(text)'::regprocedure) AND (prosecdef OR provolatile<>'i')); ")=='t','sql_parser_privileges')
def payload(kind):
    with tarfile.open(ROOT/(kind+'.tar')) as archive:
        files=[e for e in archive.getmembers() if not e.isdir()]
        require(len(files)==1 and files[0].name=='supabase/functions/'+FILE and files[0].isfile()
            and 0<files[0].size<50000,'archive_scope')
        return archive.extractfile(files[0]).read().replace(b'\r\n',b'\n')
def source_delta(live,old,new):
    require(live.replace(b'\r\n',b'\n')==old,'edge_baseline_drift')
    require(b'function normalizeProviderDubbedCategory' not in old
        and new.count(b'function normalizeProviderDubbedCategory')==1
        and new.count(b'value = normalizeProviderDubbedCategory(value);')==1,'candidate_parser_mismatch')
    return new
def stage():
    commit=sys.argv[2];require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
    proof=json.loads(PROOF.read_text());migration=(ROOT/MIGRATION).read_bytes().replace(b'\r\n',b'\n')
    require(proof.get('passed') is True and proof.get('cases',0)>=65 and proof.get('securityChecks')==2
        and proof.get('network')=='none' and proof.get('productionWrites')==0 and proof.get('providerRequests')==0
        and proof.get('fixtureRemoved') is True and proof.get('migrationSha256')==base.sha(migration),'sql_proof_mismatch')
    before_sql=definitions();require(len(before_sql)==1 and before_sql[0]['signature']=='catalog_provider_language(jsonb,text,text)','sql_baseline_scope')
    originals={name:gw.inspect(name) for name in base.SERVICES}
    roots=[base.lib.edge_root(c) for c in originals.values()];require(len(set(roots))==1,'replica_roots_differ')
    for c in originals.values():base.lib.edge_health(c)
    old=roots[0];candidate=source_delta((old/FILE).read_bytes(),payload('base'),payload('candidate'))
    before=base.edge.hashes(old);target=ROOT/'functions';shutil.copytree(old,target)
    (target/FILE).write_bytes(candidate);(target/FILE).chmod(0o644);after=base.edge.hashes(target)
    require(set(before)==set(after) and all(after[k]==v for k,v in before.items() if k!=FILE),'unrelated_edge_change')
    protected=[PROOF,ROOT/MIGRATION,ROOT/'base.tar',ROOT/'candidate.tar',pathlib.Path(__file__)]
    plan={'commit':commit,'stagedAt':time.time(),'containers':originals,'before':before,'after':after,'sqlBefore':before_sql,
        'gateway':gw.inspect(),'gatewaySources':base.parent.source_snapshot(),'binaries':gw.binary_snapshot(),
        'runtime':gw.runtime_snapshot(gw.health()),'controls':base.core.base.r.controls(),'crons':base.core.base.r.crons(),
        'otherContainers':{'norva-selection-audio-worker':gw.inspect('norva-selection-audio-worker')['Id']},
        'protectedFiles':{str(p):base.sha(p.read_bytes()) for p in protected}}
    save('plan.private.json',plan);base.invariant(plan)
    for name in base.SERVICES:base.verify_edge(plan,name,False)
    print(json.dumps({'staged':True,'commit':commit,'edgeFiles':1,'productionUnchanged':True}))
def apply_sql(plan):
    require(definition_map(definitions())==definition_map(plan['sqlBefore']),'sql_baseline_changed')
    # A transaction-level definition guard prevents an intervening release from
    # being overwritten after the read-only preflight above.
    migration=(ROOT/MIGRATION).read_text().replace('\r\n','\n')
    anchor="set local statement_timeout = '30s';"
    require(migration.count(anchor)==1,'migration_guard_missing')
    guards=[]
    for row in plan['sqlBefore']:
        guards.append('IF pg_get_functiondef('+base.fleet.literal(row['signature'])+'::regprocedure) IS DISTINCT FROM '+
            base.fleet.literal(row['definition'])+" THEN RAISE EXCEPTION 'SQL baseline changed'; END IF;")
    migration=migration.replace(anchor,anchor+'\nDO $guard$ BEGIN '+''.join(guards)+' END $guard$;')
    save('sql-attempt.private.json',{'at':time.time()});sql(migration,write=True);verify_sql()
    save('sql.private.json',{'at':time.time(),'applied':True,'observationsChanged':False})
def activate(plan,name):
    base.invariant(plan);verify_sql();base.verify_edge(plan,name,False);base.idle()
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
def recover(plan):
    require(not base.process_alive('run'),'runner_still_active');base.idle();base.invariant(plan)
    for name in reversed(base.SERVICES):
        if not (ROOT/(name+'-receipt.private.json')).exists():continue
        receipt=saved(name+'-receipt.private.json');inventory=gw.docker_api('GET','/containers/json?all=true')
        owners=[row['Id'] for row in inventory if '/'+name in row.get('Names',[])]
        require(len(owners)<=1 and (not owners or owners[0] in (plan['containers'][name]['Id'],receipt['candidateContainer'])),'foreign_edge_alias')
        if not owners or owners[0]!=plan['containers'][name]['Id']:base.edge.restore(name,plan,receipt)
        base.verify_edge(plan,name,False)
    installed=len(definitions())==2
    if installed:verify_sql()
    else:require(definition_map(definitions())==definition_map(plan['sqlBefore']),'partial_sql_migration')
    base.core.base.r.alter_crons(plan,False);require(base.core.base.r.crons()==plan['crons'],'cron_restore_missing')
    save('closed.private.json',{'at':time.time(),'updated':False,'sqlApplied':installed,'cronsRestored':True,'oldEdgeRestored':True})

# Only missing derived hints, in bounded transactions with row locks. Existing
# evidence, metadata, quarantine and certificates are neither replaced nor reset.
def backfill():
    plan=saved('plan.private.json');require(saved('closed.private.json').get('updated') is True,'release_not_complete')
    base.invariant(plan);verify_sql()
    for name in base.SERVICES:base.verify_edge(plan,name,True)
    records=sorted(ROOT.glob('backfill-*.private.json'))
    state=json.loads(records[-1].read_text()) if records else {'after':None,'scanned':0,'inserted':0,'batch':0,'done':False}
    deadline=time.time()+300
    while not state['done'] and time.time()<deadline:
        cursor=state['after'];require(cursor is None or re.fullmatch('[a-f0-9-]{36}',cursor),'cursor_invalid')
        query="""BEGIN; SET LOCAL ROLE service_role; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
WITH candidates AS MATERIALIZED (
 SELECT v.id,v.user_id,v.title_id,v.source_id,v.item_type,v.metadata,v.external_id,v.raw_title
 FROM public.cloud_title_variants v WHERE (CURSOR IS NULL OR v.id>CURSOR)
 AND v.item_type IN ('movie','series')
 AND (coalesce(v.metadata->>'categoryName',v.metadata->>'category_name','') ~* 'dub' OR v.raw_title ~* 'dub')
 AND NOT EXISTS(SELECT 1 FROM public.cloud_catalog_provider_language_hints h WHERE h.variant_id=v.id)
 ORDER BY v.id LIMIT 500 FOR SHARE OF v
), parsed AS MATERIALIZED (
 SELECT *,public.catalog_provider_language(metadata,external_id,raw_title) AS language FROM candidates
), added AS (
 INSERT INTO public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
 SELECT id,user_id,title_id,source_id,item_type,language FROM parsed WHERE language IS NOT NULL
 ON CONFLICT(variant_id) DO NOTHING RETURNING variant_id
)
SELECT jsonb_build_object('after',(SELECT max(id::text) FROM candidates),'scanned',(SELECT count(*) FROM candidates),'inserted',(SELECT count(*) FROM added)); COMMIT;"""
        literal='NULL::uuid' if cursor is None else base.fleet.literal(cursor)+'::uuid'
        result=json.loads(sql(query.replace('CURSOR',literal),write=True))
        state={'after':result['after'] or cursor,'scanned':state['scanned']+result['scanned'],
            'inserted':state['inserted']+result['inserted'],'batch':state['batch']+1,'done':result['scanned']==0,'at':time.time()}
        save('backfill-'+str(state['batch']).zfill(6)+'.private.json',state)
        print(json.dumps({k:v for k,v in state.items() if k!='after'}),flush=True)
    return state
base.stage,base.apply_sql,base.verify_sql,base.activate,base.recover=stage,apply_sql,verify_sql,activate,recover
if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1];require(phase in ('stage','launch','run','watch','status','backfill'),'invalid_phase')
        backfill() if phase=='backfill' else getattr(base,phase)()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'provider_dubbed_release_failed'}));sys.exit(1)
