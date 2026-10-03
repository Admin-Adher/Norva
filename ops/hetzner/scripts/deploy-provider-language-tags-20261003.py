"""Bounded provider-tag release using the existing sequential Edge supervisor."""
import importlib.util,json,os,sys,time,hashlib
from pathlib import Path
ROOT=Path('/home/adrien/.norva/provider-language-tags-20261003')
spec=importlib.util.spec_from_file_location('tag_release_base',ROOT.parent/'provider-audio-catchup-20261003/deploy-provider-audio-catchup-20261003.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.ROOT=ROOT;base.CANARY='norva-language-tags-canary-20261003'
MIGRATION='20261003133000_provider_indian_language_tags.sql'

def migrate():
    base.assert_reference()
    current=base.sql("select prosrc from pg_proc where oid='public.catalog_provider_language(jsonb,text,text)'::regprocedure").strip()
    expected=(ROOT/'baseline-parser.sql').read_text().split('$f$')[1].strip()
    assert current==expected,'live_sql_parser_drift'
    (ROOT/'parser-before.sql').write_text(base.sql("select pg_get_functiondef('public.catalog_provider_language(jsonb,text,text)'::regprocedure)"))
    base.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],(ROOT/MIGRATION).read_bytes())
    print(json.dumps({'migrationApplied':MIGRATION}))

def backfill():
    assert (ROOT/'deployment.safe.json').exists(),'edge_not_deployed'
    expected=(ROOT/MIGRATION).read_text().split('$f$')[1].strip()
    assert base.sql("select prosrc from pg_proc where oid='public.catalog_provider_language(jsonb,text,text)'::regprocedure").strip()==expected,'sql_parser_drift'
    statefile=ROOT/'backfill.private.json';state=json.loads(statefile.read_text()) if statefile.exists() else {'after':None,'scanned':0,'inserted':0,'done':False}
    while not state['done']:
        cursor='null::uuid' if state['after'] is None else "'"+state['after']+"'::uuid"
        statement="""begin;set local role service_role;set local lock_timeout='2s';set local statement_timeout='25s';set local jit=off;
with batch as materialized(
 select v.* from cloud_title_variants v
 where (CURSOR is null or v.id>CURSOR) and v.item_type in ('movie','series')
 and btrim(regexp_replace(coalesce(v.metadata->>'categoryName',v.metadata->>'category_name',''),'\\s+',' ','g'))='VOD - INDIA'
 and v.raw_title ~ '^\\s*(TG|TM)(\\s*[-–—|:])'
 and not exists(select 1 from cloud_catalog_provider_language_hints h where h.variant_id=v.id)
 order by v.id limit 500 for share of v
), parsed as materialized(select *,catalog_provider_language(metadata,external_id,raw_title) as language from batch),
inserted as (insert into cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
 select id,user_id,title_id,source_id,item_type,language from parsed where language in ('te','ta')
 on conflict(variant_id) do nothing returning user_id)
select jsonb_build_object('after',(select max(id::text) from batch),'scanned',(select count(*) from batch),'inserted',(select count(*) from inserted));commit;""".replace('CURSOR',cursor)
        result=json.loads(base.sql(statement))
        state={'after':result['after'] or state['after'],'scanned':state['scanned']+result['scanned'],'inserted':state['inserted']+result['inserted'],'done':result['scanned']==0}
        statefile.write_text(json.dumps(state))
        print(json.dumps({k:v for k,v in state.items() if k!='after'}),flush=True)
        time.sleep(.25)
    base.sql("""begin;set local role service_role;set local statement_timeout='25s';
do $$declare owner uuid;begin
 for owner in select distinct v.user_id from cloud_title_variants v join cloud_catalog_provider_language_hints h on h.variant_id=v.id
 where h.language in ('te','ta') and v.metadata->>'categoryName'='VOD - INDIA' and v.raw_title ~ '^\\s*(TG|TM)(\\s*[-–—|:])'
 loop perform norva_bump_user_catalog_visibility_epoch(owner);delete from cloud_catalog_facet_summary where user_id=owner;end loop;
end$$;commit;""")
    print(json.dumps({'catalogueCachesInvalidated':True}))

if __name__=='__main__':
    os.umask(0o077)
    mode=sys.argv[1];assert mode in ('stage','canary','migrate','apply','backfill')
    {'stage':base.stage,'canary':base.canary,'migrate':migrate,'apply':base.apply,'backfill':backfill}[mode]()
