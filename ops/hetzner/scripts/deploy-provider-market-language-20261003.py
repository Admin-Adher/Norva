"""Release scoped catalogue-language fallbacks; preserve file observations."""
import importlib.util,json,os,sys,time
from pathlib import Path
ROOT=Path('/home/adrien/.norva/provider-market-language-20261003')
spec=importlib.util.spec_from_file_location('market_release_base',ROOT.parent/'provider-audio-catchup-20261003/deploy-provider-audio-catchup-20261003.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.ROOT=ROOT;base.CANARY='norva-market-language-canary-20261003'
MIGRATION='20261003163000_provider_scoped_market_language_tags.sql'
FILTER="v.raw_title ~ '^\\s*(4K-)?(BR|HU|IS|QC|IR|IL|MY|PH|CH|CN|SW|PB|SC|INI?)(\\s*[-–—|:])'"

def assert_sql():
    expected=(ROOT/MIGRATION).read_text().split('$f$')[1].strip()
    assert base.sql("select prosrc from pg_proc where oid='public.catalog_provider_language(jsonb,text,text)'::regprocedure").strip()==expected,'sql_parser_drift'

def migrate():
    base.assert_reference()
    expected=(ROOT/'baseline-parser.sql').read_text().split('$f$')[1].strip()
    assert base.sql("select prosrc from pg_proc where oid='public.catalog_provider_language(jsonb,text,text)'::regprocedure").strip()==expected,'live_parser_drift'
    (ROOT/'parser-before.sql').write_text(base.sql("select pg_get_functiondef('public.catalog_provider_language(jsonb,text,text)'::regprocedure)"))
    base.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],(ROOT/MIGRATION).read_bytes())
    assert_sql();print(json.dumps({'migrationApplied':MIGRATION}),flush=True)

def backfill():
    assert (ROOT/'deployment.safe.json').exists(),'edge_not_deployed'
    assert_sql()
    queuefile=ROOT/'candidates.private.json';statefile=ROOT/'backfill.private.json'
    if not queuefile.exists():
        # Snapshot visible candidates without evaluating the full parser across
        # the fleet in one statement. Each bounded write batch parses them below.
        # Do not enrich superseded generations.
        rows=base.sql("""set default_transaction_read_only=on;set statement_timeout='60s';set jit=off;set enable_nestloop=off;
select json_build_object('id',v.id,'owner',v.user_id,'source',v.source_id) from cloud_catalog_visible_title_variants v
where FILTER and v.item_type in ('movie','series')
and not exists(select 1 from cloud_catalog_provider_language_hints h where h.variant_id=v.id)
order by v.id;""".replace('FILTER',FILTER))
        queue=[json.loads(x) for x in rows.splitlines() if x.startswith('{')]
        queuefile.write_text(json.dumps(queue));queuefile.chmod(0o600)
    queue=json.loads(queuefile.read_text())
    state=json.loads(statefile.read_text()) if statefile.exists() else {'offset':0,'inserted':0,'owners':[]}
    while state['offset']<len(queue):
        batch=queue[state['offset']:state['offset']+500]
        payload=json.dumps(batch).replace("'","''")
        statement="""begin;set local role service_role;set local lock_timeout='2s';set local statement_timeout='25s';set local jit=off;
with targets as materialized(select * from jsonb_to_recordset('PAYLOAD'::jsonb) as q(id uuid,owner uuid,source uuid)),
batch as materialized(select v.* from cloud_title_variants v join targets q on q.id=v.id and q.owner=v.user_id and q.source=v.source_id
where FILTER and not exists(select 1 from cloud_catalog_provider_language_hints h where h.variant_id=v.id) for share of v),
parsed as materialized(select *,catalog_provider_language(metadata,external_id,raw_title) resolved from batch),
inserted as(insert into cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
select id,user_id,title_id,source_id,item_type,resolved from parsed where resolved is not null on conflict(variant_id) do nothing returning user_id)
select jsonb_build_object('inserted',count(*),'owners',coalesce(jsonb_agg(distinct user_id),'[]'::jsonb)) from inserted;commit;""".replace('PAYLOAD',payload).replace('FILTER',FILTER)
        # A transient lock conflict rolls back the whole batch; the cursor only
        # advances after commit, so an interrupted run can safely resume.
        for attempt in range(3):
            try:result=json.loads(base.sql(statement));break
            except RuntimeError:
                if attempt==2:raise
                time.sleep(2)
        state['offset']+=len(batch);state['inserted']+=result['inserted']
        state['owners']=sorted(set(state['owners']+result['owners']))
        statefile.write_text(json.dumps(state));statefile.chmod(0o600)
        if state['offset']%5000==0 or state['offset']==len(queue):
            print(json.dumps({'processed':state['offset'],'candidates':len(queue),'inserted':state['inserted']}),flush=True)
        time.sleep(.15)
    for owner in state['owners']:
        statement="begin;set local lock_timeout='2s';set local statement_timeout='25s';select norva_bump_user_catalog_visibility_epoch('"+owner+"'::uuid);delete from cloud_catalog_facet_summary where user_id='"+owner+"'::uuid;commit;"
        base.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],statement.encode())
    print(json.dumps({'done':True,'inserted':state['inserted'],'owners':len(state['owners']),'catalogueCachesInvalidated':True}),flush=True)

if __name__=='__main__':
    os.umask(0o077)
    mode=sys.argv[1];assert mode in ('stage','canary','migrate','apply','backfill')
    {'stage':base.stage,'canary':base.canary,'migrate':migrate,'apply':base.apply,'backfill':backfill}[mode]()
