"""Isolated PostgreSQL replay of all completed Selection audio bindings."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT=Path('/home/adrien/.norva/selection-audio-audit-20261003')
DATABASE='norva_selection_editorial_gap_qa_20261002'
MIGRATION='20261003010000_selection_shared_completed_audio.sql'
FALLBACK='20261003011000_selection_shared_audio_provider_fallback.sql'

def sql(query,database=DATABASE):
    p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1',
        '-U','supabase_admin','-d',database],input=query,text=True,capture_output=True,timeout=65)
    if p.returncode:raise RuntimeError(p.stderr[-1600:])
    return p.stdout.strip()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    migration=(ROOT/MIGRATION).read_text(encoding='utf-8-sig')
    fallback=(ROOT/FALLBACK).read_text(encoding='utf-8-sig')
    if sql("select to_regprocedure('public.norva_refresh_selection_shared_audio(text[],integer)') is null;")=='t':
        sql(migration)
    if 'catalog_provider_language' not in sql("select pg_get_functiondef('public.norva_refresh_selection_shared_audio(text[],integer)'::regprocedure);"):
        sql(fallback)
    jobs=[j for j in json.loads((ROOT/'jobs.private.json').read_text()) if j['state']=='completed']
    payload=json.dumps(jobs).replace("'","''")
    query="""begin;set local statement_timeout='50s';
      insert into catalog_selection_audio_jobs select * from jsonb_populate_recordset(null::catalog_selection_audio_jobs,
      '%s'::jsonb) on conflict(external_id,url_sha256) do update set state='completed',profile=excluded.profile,
       result=excluded.result,completed_at=excluded.completed_at,hydration_pending=true;
      set local request.jwt.claim.role='service_role';
      do $test$ declare before_media text;before_variants text;after_media text;after_variants text;r jsonb;r2 jsonb; begin
        select md5(jsonb_agg(to_jsonb(m)-'file_tags' order by release_id,item_type,external_id)::text) into before_media from selection_shared_media m;
        select md5(jsonb_agg(to_jsonb(v) order by release_id,item_type,external_id)::text) into before_variants from selection_shared_variants v;
        r:=norva_refresh_selection_shared_audio(null,250);
        if (r->>'updatedFiles')::int<1 then raise exception 'No completed proof exercised';end if;
        r2:=norva_refresh_selection_shared_audio(null,250);
        if r2->>'updatedFiles'<>'0' then raise exception 'Repeated publication wrote again';end if;
        if exists(select 1 from selection_shared_variants v join selection_shared_media m
          on m.release_id=v.release_id and m.item_type='movie' and m.external_id=v.external_id
          where v.item_type='movie' and m.available
            and catalog_provider_language(v.metadata,v.external_id,v.raw_title) is not null
            and not exists(select 1 from selection_shared_languages l where l.release_id=v.release_id
              and l.item_type='movie' and l.external_id=v.external_id and l.kind='audio')) then
          raise exception 'Explicit provider fallback lost';end if;
        select md5(jsonb_agg(to_jsonb(m)-'file_tags' order by release_id,item_type,external_id)::text) into after_media from selection_shared_media m;
        select md5(jsonb_agg(to_jsonb(v) order by release_id,item_type,external_id)::text) into after_variants from selection_shared_variants v;
        if before_media is distinct from after_media or before_variants is distinct from after_variants then raise exception 'Editorial/file identity changed';end if;
        if exists(select 1 from selection_shared_media where file_tags::text like '%%receipt%%' or file_tags::text like '%%verification%%') then
          raise exception 'Private evidence exposed';end if;
        if has_function_privilege('authenticated','public.norva_refresh_selection_shared_audio(text[],integer)','EXECUTE') then
          raise exception 'Public writer privilege';end if;
        begin
          perform norva_refresh_selection_shared_audio(null,251);
          raise exception 'Missing publication bound';
        exception when sqlstate '22023' then null;end;
        -- A changed file's certificate must never be reused on its old URL.
        declare j catalog_selection_audio_jobs;begin
          select * into j from catalog_selection_audio_jobs where state='completed' limit 1;
          update catalog_selection_audio_jobs set profile=jsonb_set(profile,'{urlSha256}','"wrong-file"') where id=j.id;
          update selection_shared_media set file_tags=file_tags-'analysisCompletedAt' where external_id=j.external_id;
          begin
            perform norva_refresh_selection_shared_audio(array[j.external_id],250);
            raise exception 'Foreign file proof accepted';
          exception when sqlstate 'PT409' then null;end;
          update catalog_selection_audio_jobs set profile=j.profile where id=j.id;
        end;
        raise notice 'SELECTION_AUDIO_PUBLICATION_PASS %%',r;
      end $test$;
      select norva_refresh_selection_shared_audio(null,250);rollback;"""%payload
    result=sql(query);(ROOT/'publication-qa.safe.txt').write_text(result)
    print(json.dumps({'qaRollbackPassed':True,'completedProofs':len(jobs),'database':DATABASE}))
    if args.apply:
        installed=sql("select to_regprocedure('public.norva_refresh_selection_shared_audio(text[],integer)') is not null;",'postgres')=='t'
        before=sql("""select jsonb_build_object('media',(select jsonb_agg(m) from selection_shared_media m),
          'titles',(select jsonb_agg(t) from selection_shared_titles t),
          'languages',(select jsonb_agg(l) from selection_shared_languages l));""",'postgres')
        backup=ROOT/('before-audio-fallback.private.json' if installed else 'before-audio-publication.private.json')
        backup.write_text(before);backup.chmod(0o600)
        old=sql("select pg_get_functiondef('public.ack_selection_audio_hydration(text,text)'::regprocedure);",'postgres')
        if not installed:
            (ROOT/'before-ack.sql').write_text(old)
            sql(migration,'postgres')
        assert 'catalog_provider_language' not in sql("select pg_get_functiondef('public.norva_refresh_selection_shared_audio(text[],integer)'::regprocedure);",'postgres'),'Fallback already installed'
        sql(fallback,'postgres')
        result=sql("begin;set local statement_timeout='45s';set local request.jwt.claim.role='service_role';"
          "select norva_refresh_selection_shared_audio(null,250);commit;",'postgres')
        (ROOT/'publication-production.safe.json').write_text(result)
        print(result)

if __name__=='__main__':main()
