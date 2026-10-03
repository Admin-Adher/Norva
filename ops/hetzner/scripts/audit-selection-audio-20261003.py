"""Read-only exact-file inventory of unidentified Selection audio.

Run on the Norva database host. Private inputs stay on that host; stdout only
contains aggregate diagnostics. No language is inferred from film nationality.
"""
import collections
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')

def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
        '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
        input="set statement_timeout='45s';\n" + query, text=True, capture_output=True, timeout=55)
    if result.returncode:
        raise RuntimeError(result.stderr[-1200:])
    return result.stdout.strip()

def main():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    schema = json.loads(sql("""select jsonb_object_agg(table_name, cols) from (
      select table_name,jsonb_agg(jsonb_build_object('name',column_name,'type',data_type)
        order by ordinal_position) cols from information_schema.columns where table_schema='public'
        and table_name in ('catalog_selection_audio_jobs','selection_shared_titles',
          'selection_shared_variants','selection_shared_media','selection_shared_languages',
          'selection_shared_releases','cloud_sources') group by table_name) q;"""))
    (ROOT/'schema.safe.json').write_text(json.dumps(schema, indent=2))
    jobs = json.loads(sql("select coalesce(jsonb_agg(j),'[]') from catalog_selection_audio_jobs j;"))
    (ROOT/'jobs.private.json').write_text(json.dumps(jobs))
    states = collections.Counter((j['state'],j.get('error_code')) for j in jobs)
    print(json.dumps({'jobs':len(jobs),'states':[{'state':k[0],'error':k[1],'count':v}
        for k,v in states.items()]}), flush=True)
    counts = json.loads(sql("""select jsonb_agg(x) from(select item_type,count(*) total,
      count(*) filter(where coalesce(cardinality(file_audio_languages),0)=0) unknown_file,
      count(*) filter(where coalesce(cardinality(audio_languages),0)=0) unknown_audio
      from selection_shared_titles where release_id=(select id from selection_shared_releases
        where published_at is not null order by published_at desc limit 1)
      group by item_type) x;"""))
    print(json.dumps({'sharedCounts':counts,'at':time.time()}),flush=True)
    rows=json.loads(sql("""with release as (select id from selection_shared_releases
      where published_at is not null order by published_at desc limit 1),
    known as (select distinct v.item_type,v.identity_key from selection_shared_variants v
      join release r on r.id=v.release_id join selection_shared_languages l
      on l.release_id=v.release_id and l.item_type=v.item_type and l.external_id=v.external_id and l.kind='audio')
    select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('files',
      (select coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('media',to_jsonb(m),'job',to_jsonb(j))),'[]')
       from selection_shared_variants v left join selection_shared_media m on m.release_id=v.release_id
       and m.item_type=v.item_type and m.external_id=v.external_id
       left join catalog_selection_audio_jobs j on j.external_id=v.external_id
       and j.url_sha256=encode(sha256(convert_to(v.playback_hint->>'targetUrl','UTF8')),'hex')
       where v.release_id=t.release_id and v.item_type=t.item_type and v.identity_key=t.identity_key))),'[]')
      from selection_shared_titles t join release r on r.id=t.release_id
      where t.item_type='movie' and not exists(select 1 from known k where k.item_type=t.item_type and k.identity_key=t.identity_key);"""))
    (ROOT/'unknown-shared.private.json').write_text(json.dumps(rows))
    files=[f for r in rows for f in r['files']]
    print(json.dumps({'unknownSharedTitles':len(rows),'unknownFiles':len(files),
       'fileStates':dict(collections.Counter((f.get('job') or {}).get('state','no_job') for f in files)),
       'fileErrors':dict(collections.Counter((f.get('job') or {}).get('error_code') or 'none' for f in files)),
       'completedLanguages':dict(collections.Counter(t.get('lang') or t.get('language') or 'und' for f in files
         for t in ((f.get('job') or {}).get('result') or {}).get('audioTracks',[])))}),flush=True)
    for name in ['claim_selection_audio_job','finish_selection_audio_job','checkpoint_selection_audio_job',
                 'defer_selection_audio_admission','defer_selection_audio_capture']:
        defs=sql("select pg_get_functiondef(oid) from pg_proc where pronamespace='public'::regnamespace and proname='"+name+"';")
        (ROOT/(name+'.sql')).write_text(defs)
    summary=[{'state':j['state'],'error':j.get('error_code'),'attempts':j['attempt_count'],
       'updated':j['updated_at'],'progressTrack':(j.get('progress') or {}).get('trackPosition'),
       'receiptCount':len((j.get('progress') or {}).get('receipts') or []),
       'captureTrackCount':len((j.get('profile') or {}).get('audioTracks') or []),
       'resultLanguages':[t.get('lang') or t.get('language') for t in (j.get('result') or {}).get('audioTracks',[])]}
       for j in jobs]
    (ROOT/'job-states.safe.json').write_text(json.dumps(summary))
    # This is the ordinary account already used in the authorized commercial QA.
    qa=sql("""select jsonb_build_object('userId',e.user_id,'sourceId',e.source_id)
       from selection_shared_visible_enrollments e join auth.users u on u.id=e.user_id
       where u.email='adrienhernandez20+norva-qa-commercial-20261001@gmail.com' limit 1;""")
    if qa:
        qa=json.loads(qa); user=qa['userId']; source=qa['sourceId']
        data=json.loads(sql("""with unknown as materialized(select * from
           cloud_catalog_unidentified_audio_variants('%s','movie','%s'))
          select jsonb_build_object('titles',(select count(distinct title_id) from unknown),
           'files',(select count(*) from unknown),'rows',(select jsonb_agg(to_jsonb(v)||jsonb_build_object('title',coalesce(to_jsonb(t),to_jsonb(st)),
             'shared',to_jsonb(m),'job',to_jsonb(j))) from unknown x
             join cloud_catalog_visible_title_variants v on v.id=x.variant_id and v.title_id=x.title_id
             left join cloud_titles t on t.id=x.title_id
             left join selection_shared_media m on m.external_id=v.external_id and m.item_type='movie'
               and m.release_id=(select release_id from selection_shared_visible_enrollments where source_id='%s')
             left join selection_shared_variants sv on sv.release_id=m.release_id and sv.item_type='movie' and sv.external_id=v.external_id
             left join selection_shared_titles st on st.release_id=sv.release_id and st.item_type='movie' and st.identity_key=sv.identity_key
             left join catalog_selection_audio_jobs j on j.external_id=v.external_id
               and j.url_sha256=encode(sha256(convert_to(v.playback_hint->>'targetUrl','UTF8')),'hex')));"""%(user,source,source)))
        (ROOT/'qa-unknown.private.json').write_text(json.dumps(data))
        print(json.dumps({'ordinaryQaUnknownTitles':data['titles'],'ordinaryQaUnknownFiles':data['files']}),flush=True)
        # Retain an immutable baseline before any repair or subsequent queue progress.
        baseline=ROOT/'baseline-554.private.json'
        if not baseline.exists():
            baseline.write_text(json.dumps(data));baseline.chmod(0o600)
        public=[]
        for row in data['rows'] or []:
            job=row.get('job') or {};media=row.get('shared') or {}
            result=job.get('result') or {};profile=job.get('profile') or {}
            languages=lambda tracks: sorted({t.get('lang') or t.get('language') for t in tracks or []
                if (t.get('lang') or t.get('language')) not in (None,'und','un','unknown','mul','zxx')})
            public.append({'identityKey':(row.get('title') or {}).get('identity_key'),'externalId':row['external_id'],
                'providerTitle':row['raw_title'],'state':job.get('state','no_job'),'error':job.get('error_code'),
                'attempts':job.get('attempt_count'),'completedAt':job.get('completed_at'),
                'resultLanguages':languages(result.get('audioTracks')),'resultVerified':result.get('verified'),
                'profileLanguages':languages(profile.get('audioTracks')),
                'sharedTrackLanguages':languages((media.get('file_tags') or {}).get('audioTracks')),
                'providerLanguage':row.get('language'),
                'resultTrackCount':len(result.get('audioTracks') or []),
                'profileTrackCount':len(profile.get('audioTracks') or []),
                'receiptCount':len((job.get('progress') or {}).get('receipts') or [])})
        (ROOT/'qa-inventory.safe.json').write_text(json.dumps(public,indent=2,ensure_ascii=False))
        print(json.dumps({'allQaFilesReviewed':len(public),'states':dict(collections.Counter(r['state'] for r in public)),
            'errors':dict(collections.Counter(r['error'] or 'none' for r in public)),
            'finishedWithLanguages':sum(bool(r['resultLanguages']) for r in public),
            'finishedInconclusive':sum(r['state']=='completed' and not r['resultLanguages'] for r in public),
            'probedWithLanguagesNotFinished':sum(r['state']!='completed' and bool(r['profileLanguages']) for r in public),
            'sharedHasLanguageButOwnerUnknown':sum(bool(r['sharedTrackLanguages']) for r in public)}),flush=True)

if __name__ == '__main__':
    main()
