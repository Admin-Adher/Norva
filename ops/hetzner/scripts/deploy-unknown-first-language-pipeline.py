"""Bound, staged SQL publication; no provider I/O, cron/queue resets or Edge restart.

inspect -> rehearse (rollback) -> apply -> verify. Metadata projection stays OFF
until the separately validated Edge rollout; priority improvement is immediate.
Rollback restores old function bodies, retaining inert columns and collected
declarations rather than destroying evidence. Errors/artifacts remain private.
"""
import hashlib, json, os, pathlib, re, subprocess, sys, time

ROOT=pathlib.Path('/home/adrien/.norva/unknown-first-language-pipeline-20260914')
MIGRATIONS=['20260914133000_unknown_first_language_intake.sql','20260914134000_owned_provider_stream_languages.sql','20260914135000_unknown_series_metadata_refresh.sql']
SIGNATURES=['claim_catalog_vod_language_file(uuid,uuid)','cloud_catalog_effective_audio_languages(uuid,text,uuid,text)',
  'register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb)','catalog_series_inventory_candidates(uuid,uuid,integer)']
OWNERS={name:('postgres' if name.startswith('cloud_catalog_effective_audio_languages(') else 'supabase_admin') for name in SIGNATURES}

def require(ok,code):
    if not ok:raise RuntimeError(code)
def sha(value):return hashlib.sha256(value).hexdigest()
def read(name):return json.loads((ROOT/name).read_text())
def save(name,value):
    with (ROOT/name).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2)
def query(sql,write=False):
    args=['docker','exec']
    if not write:args+=['-e','PGOPTIONS=-c default_transaction_read_only=on']
    args+=['-i','norva-db','psql','-X','-qAt','-U','supabase_admin' if write else 'postgres','-d','postgres','-v','ON_ERROR_STOP=1']
    if not write:sql="BEGIN READ ONLY; SET LOCAL statement_timeout='30s'; "+sql+' ROLLBACK;'
    p=subprocess.run(args,input=sql,text=True,capture_output=True,timeout=90)
    if p.returncode:
        (ROOT/('sql-error-'+str(time.time_ns())+'.private.txt')).write_text(p.stderr)
        raise RuntimeError('sql_failed')
    return p.stdout.strip()
def definitions():
    names=','.join("'public."+name+"'" for name in SIGNATURES)
    return json.loads(query("select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p where p.oid in (select to_regprocedure(x) from unnest(array["+names+"]) x);"))
def state():
    return json.loads(query("""select jsonb_build_object('at',clock_timestamp(),
    'metadataEnabled',coalesce((select enabled from public.admin_feature_flags where key='owned_provider_language_metadata_enabled'),false),
    'flags',(select jsonb_object_agg(key,enabled) from public.admin_feature_flags where key in
      ('automatic_vod_language_fleet_enabled','audio_lid_enabled','enrichment_paused','language_metadata_lane_enabled','language_exact_file_admission_enabled','adaptive_language_admission_enabled')),
    'cron',(select jsonb_agg(jsonb_build_object('id',jobid,'active',active) order by jobid) from cron.job),
    'declarationTable',to_regclass('public.catalog_owned_language_declarations') is not null,
    'priorityInstalled',to_regprocedure('public.catalog_movie_audio_identified(uuid,uuid,uuid)') is not null);"""))
def bind():
    cfg=read('release-manifest.private.json')
    require(re.fullmatch('[a-f0-9]{40}',cfg.get('commit','')),'commit_required')
    require(set(cfg['migrations'])==set(MIGRATIONS),'migration_scope')
    for name in MIGRATIONS:require(sha((ROOT/name).read_bytes())==cfg['migrations'][name],'migration_hash_drift')
    return cfg
def migration_sql():
    chunks=[]
    for name in MIGRATIONS:
        body=(ROOT/name).read_text()
        require(len(re.findall(r'^begin;$',body,re.M))==1 and len(re.findall(r'^commit;$',body,re.M))==1,'transaction_boundary')
        chunks.append(re.sub(r'^(?:begin|commit);\n?','',body,flags=re.M))
    return '\n'.join(chunks)
def unchanged(before):
    now=state();require(now['flags']==before['flags'] and now['cron']==before['cron'],'runtime_controls_drift')
    require(now['metadataEnabled'] is False,'metadata_must_stay_disabled')
    return now
def main():
    os.umask(0o077)
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077==0,'private_root_required')
    cfg=bind();mode=sys.argv[1] if len(sys.argv)>1 else ''
    if mode=='inspect':
        current=state();require(not current['priorityInstalled'] and not current['declarationTable'],'already_installed')
        rows=definitions();require({r['signature']:r['owner'] for r in rows}==OWNERS,'definition_scope')
        save('sql-before.private.json',{'commit':cfg['commit'],'state':current,'functions':rows})
        print(json.dumps({'preflight':True,'metadataEnabled':False,'functions':4}))
    elif mode=='rehearse':
        before=read('sql-before.private.json');require(before['commit']==cfg['commit'] and definitions()==before['functions'],'baseline_drift')
        unchanged(before['state'])
        query('BEGIN; '+migration_sql()+"\nSELECT 1; ROLLBACK;",True)
        require(definitions()==before['functions'] and not state()['priorityInstalled'],'rollback_proof_failed')
        unchanged(before['state']);save('sql-rehearsed.private.json',{'commit':cfg['commit'],'migrationHashes':cfg['migrations'],'rollbackVerified':True})
        print(json.dumps({'rehearsed':True,'rollbackVerified':True,'providerRequests':0}))
    elif mode=='apply':
        before=read('sql-before.private.json');proof=read('sql-rehearsed.private.json')
        require(proof['commit']==cfg['commit'] and proof['migrationHashes']==cfg['migrations'],'rehearsal_binding')
        require(definitions()==before['functions'],'baseline_drift');unchanged(before['state'])
        save('sql-apply-intent.private.json',{'commit':cfg['commit'],'at':time.time()})
        # No data backfill; the new table captures only future owned responses.
        query('BEGIN; '+migration_sql()+'\nCOMMIT;',True)
        current=unchanged(before['state']);require(current['priorityInstalled'] and current['declarationTable'],'installation_missing')
        save('sql-applied.private.json',{'commit':cfg['commit'],'state':current,'functions':definitions()})
        print(json.dumps({'sqlApplied':True,'priorityActive':True,'metadataProjectionEnabled':False,'cronUnchanged':True,'providerRequests':0}))
    elif mode=='verify':
        applied=read('sql-applied.private.json');require(applied['commit']==cfg['commit'],'commit_drift')
        require(definitions()==applied['functions'],'installed_definitions_drift');current=unchanged(read('sql-before.private.json')['state'])
        print(json.dumps({'verified':True,'commit':cfg['commit'],'priorityInstalled':current['priorityInstalled'],'metadataProjectionEnabled':current['metadataEnabled']}))
    elif mode=='rollback':
        before=read('sql-before.private.json');require(before['commit']==cfg['commit'],'commit_drift')
        applied=read('sql-applied.private.json');require(definitions()==applied['functions'],'installed_definitions_drift')
        unchanged(before['state'])
        query("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; "+
              '\n'.join(row['definition']+';' for row in before['functions'])+" NOTIFY pgrst,'reload schema'; COMMIT;",True)
        require(definitions()==before['functions'],'rollback_body_mismatch')
        save('sql-rolled-back.private.json',{'commit':cfg['commit'],'at':time.time(),'declarationsRetained':True})
        print(json.dumps({'rolledBack':True,'declarationsRetained':True}))
    else:raise RuntimeError('mode_required')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error) if isinstance(error,RuntimeError) else type(error).__name__}));sys.exit(1)
