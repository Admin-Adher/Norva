import datetime, json, runpy, uuid
ctx=runpy.run_path('/home/adrien/.norva/language-campaign-20261003.py')
root=ctx['ROOT']; sql=ctx['sql']
m=json.loads((root/'manifest.json').read_text())
start=m['startedAt']; rows=[]
for s in m['sources']:
    owner=str(uuid.UUID(s['userId'])); sid=str(uuid.UUID(s['id']))
    ids=json.dumps([r['variantId'] for r in m['variants'] if r['sourceId']==sid])
    q=f"""with cohort as materialized(select value::uuid id from jsonb_array_elements_text('{ids}'::jsonb)),
    metadata as materialized(select d.variant_id id,max(d.observed_at) at
      from public.catalog_owned_language_declarations d join cohort c on c.id=d.variant_id
      where d.user_id='{owner}' and d.source_id='{sid}' and d.observed_at>='{start}'::timestamptz group by d.variant_id),
    profiles as materialized(select v.id,coalesce(v.codec_profile->>'probedAt',v.codec_profile->>'probed_at')::timestamptz at
      from public.cloud_catalog_visible_title_variants v join cohort c on c.id=v.id
      where v.user_id='{owner}' and v.source_id='{sid}'
      and coalesce(v.codec_profile->>'probedAt',v.codec_profile->>'probed_at','') ~ '^202[0-9]-'
      and coalesce(v.codec_profile->>'probedAt',v.codec_profile->>'probed_at')::timestamptz>='{start}'::timestamptz),
    jobs as materialized(select j.* from public.catalog_file_audio_validation_jobs j join cohort c on c.id=j.variant_id
      where j.requested_by='{owner}' and j.source_id='{sid}'),
    checked as materialized(select id,max(at) at from
      (select * from metadata union all select * from profiles union all
      select variant_id,last_provider_progress_at from jobs where last_provider_progress_at>='{start}'::timestamptz) x group by id)
    select jsonb_build_object('at',clock_timestamp(),'metadataChecked', (select count(*) from metadata),
      'profilesProbed',(select count(*) from profiles),'strictWithProgress',(select count(distinct variant_id) from jobs where last_provider_progress_at>='{start}'::timestamptz),
      'uniqueChecked',(select count(*) from checked),'uniqueLast15Min',(select count(*) from checked where at>=now()-interval '15 minutes'),
      'strictRecentTerminal',(select coalesce(jsonb_object_agg(code,n),'{{}}'::jsonb) from
         (select coalesce(error_code,state) code,count(distinct variant_id) n from jobs
          where state in ('verified','failed','expired','cancelled') and updated_at>='{start}'::timestamptz
          group by coalesce(error_code,state)) x));"""
    result=sql(q)[0];result['source']=s['label']; rows.append(result)
    print(json.dumps(result),flush=True)
now=datetime.datetime.now(datetime.timezone.utc)
elapsed=(now-datetime.datetime.fromisoformat(start)).total_seconds()
total=sum(r['uniqueChecked'] for r in rows)
rate=total*3600/elapsed
report={'startedAt':start,'at':now.isoformat(),'initial':len(m['variants']),'uniqueChecked':total,
    'elapsedMinutes':elapsed/60,'checkedPerHour':rate,'remainingFirstPassDays':(len(m['variants'])-total)/rate/24 if rate else None,
    'sources':rows}
ctx['save'](root/'coverage.safe.json',report)
print(json.dumps(report))
