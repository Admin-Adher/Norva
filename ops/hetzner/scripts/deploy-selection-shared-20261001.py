"""Selection enrollment release. Keep SQL/read paths on rollback; disable new enrollments.

Upload the reviewed files and a freshly built PUBLIC publication.json to ROOT.
Run schema, edge, publish, enable sequentially. No customer catalog is removed.
"""
import hashlib, json, os, pathlib, subprocess, sys, time

ROOT=pathlib.Path('/home/adrien/.norva/selection-shared-release-20261001')
EDGE=pathlib.Path('/home/adrien/.norva/owned-language-edge-rollout-20260928/functions')
BEFORE={
    'norva-cloud/index.ts':'279ee3b4f83ad4a77abf8e977442eb1365fc1775ed8251b37fd76364309ec50d',
    'norva-playback/index.ts':'1c40c3f941ffd7f9ce89f4b7cd21f56ddf7a4ff285c3140116c3f9ca45651863',
    'norva-source-sync/index.ts':'1d93660db44462e64d92fa90e1777400fdd54ea04b8581eb1576ae4340c1c1f1',
    '_shared/selection-shared-catalog.mjs':None,
}
def sha(data): return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def run(*args): return subprocess.check_output(args)
def sql(text):
    p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1',
      '-U','supabase_admin','-d','postgres'],input=text,text=True,capture_output=True,timeout=90)
    if p.returncode: raise RuntimeError(p.stderr[-1600:])
    return p.stdout.strip()
def literal(value): return "'"+json.dumps(value,separators=(',',':')).replace("'","''")+"'::jsonb"
def receipt(name,data):
    p=ROOT/(name+'.safe.json'); p.write_text(json.dumps(data)); os.chmod(p,0o600); print(json.dumps(data),flush=True)
def schema():
    assert sql("select to_regclass('public.selection_shared_rollout') is null;")=='t','Schema already exists'
    for f,expected in BEFORE.items():
        p=EDGE/f
        assert (sha(p.read_bytes()) if p.exists() else None)==expected,'Runtime drift: '+f
    files=sorted((ROOT/'supabase/migrations').glob('2026100112*selection_shared*.sql'))
    assert len(files)==5
    statements=[]
    for p in files:
        statements.append('\n'.join(line for line in p.read_text().splitlines() if line not in ['begin;','commit;']))
    sql("begin; select pg_advisory_xact_lock(hashtextextended('selection-shared-deploy',0));\n"+
        '\n'.join(statements)+"\nnotify pgrst,'reload schema'; commit;")
    receipt('schema',{'appliedAt':time.time(),'migrations':{p.name:sha(p.read_bytes()) for p in files}})
def edge():
    assert sql('select count(*) from cloud_source_finalize_leases where lease_until>clock_timestamp();')=='0','Finalizer busy'
    for f,expected in BEFORE.items():
        p=EDGE/f
        assert (sha(p.read_bytes()) if p.exists() else None)==expected,'Runtime drift: '+f
    backup=ROOT/'edge-before'; backup.mkdir(mode=0o700,exist_ok=False)
    applied={}
    for f in BEFORE:
        p=EDGE/f
        if p.exists():
            old=backup/f; old.parent.mkdir(parents=True,exist_ok=True); old.write_bytes(p.read_bytes())
        p.write_bytes((ROOT/'supabase/functions'/f).read_bytes()); applied[f]=sha(p.read_bytes())
    for name in ['norva-edge-functions-2','norva-edge-functions']:
        run('docker','restart',name)
        assert json.loads(run('docker','inspect',name))[0]['State']['Running']
        for f,digest in applied.items():
            assert sha(run('docker','exec',name,'cat','/home/deno/functions/'+f))==digest
        print(json.dumps({'replica':name,'verifiedFiles':len(applied)}),flush=True)
    receipt('edge',{'appliedAt':time.time(),'files':applied})
def publish():
    publication=json.loads((ROOT/'publication.json').read_text())
    from datetime import datetime
    age=time.time()-datetime.fromisoformat(publication['builtAt'].replace('Z','+00:00')).timestamp()
    assert 0<=age<900,'Refetch the public publication before deployment'
    assert len(publication['payload']['rows'])>8000 and not publication['payload']['truncated']
    statement="""begin; set local request.jwt.claim.role='service_role'; set local statement_timeout='60s';
    create temp table shared_publication(p jsonb); insert into shared_publication values (PAYLOAD);
    insert into public.selection_prepared_catalogs(revision,payload,expires_at)
      select p->>'revision',p->'payload',clock_timestamp()+interval '10 minutes' from shared_publication
      on conflict(revision) do update set payload=excluded.payload,expires_at=excluded.expires_at;
    do $publish$ declare p jsonb; r uuid; batch jsonb; matched int:=0; receipt jsonb; begin
      select shared_publication.p into p from shared_publication;
      r:=public.norva_prepare_selection_shared_release(p->>'revision');
      if exists(select 1 from public.selection_shared_releases where id=r and published_at is not null) then
        raise exception 'Release already published'; end if;
      for batch in select jsonb_agg(value) from jsonb_array_elements(p->'files') with ordinality t(value,n)
        group by (t.n-1)/250 loop matched:=matched+public.norva_seed_selection_shared_tags(r,batch); end loop;
      if matched<>jsonb_array_length(p->'files') then raise exception 'Incomplete exact-file evidence'; end if;
      perform public.norva_seed_selection_shared_live(r,p->'live'->'channels',p->'live'->'variants');
      receipt:=public.norva_publish_selection_shared_release(r);
    end $publish$;
    select jsonb_build_object('releaseId',r.id,'counts',r.counts,'publishedAt',r.published_at,'revision',r.revision)
      from public.selection_shared_releases r join shared_publication p on r.revision=p.p->>'revision'
      order by r.published_at desc limit 1;
    commit;""".replace('PAYLOAD',literal(publication))
    receipt('publication',json.loads(sql(statement)))
def rollout(enabled):
    if enabled:
        current=json.loads((ROOT/'edge.safe.json').read_text())
        for f,digest in current['files'].items(): assert sha((EDGE/f).read_bytes())==digest,'Edge changed'
        published=json.loads((ROOT/'publication.safe.json').read_text())
        assert sql("select count(*) from selection_shared_releases where id='"+published['releaseId']+"' and published_at is not null;")=='1'
    sql('update public.selection_shared_rollout set enabled='+('true' if enabled else 'false')+';')
    receipt('rollout',{'enabled':enabled,'at':time.time()})
if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='schema': schema()
    elif mode=='edge': edge()
    elif mode=='publish': publish()
    elif mode=='enable': rollout(True)
    elif mode=='disable': rollout(False)
    else: raise ValueError('Expected schema, edge, publish, enable or disable')
