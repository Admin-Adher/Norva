import collections,datetime,json,pathlib,runpy,subprocess,time
c=runpy.run_path('/home/adrien/.norva/language-campaign-20261003.py');root=pathlib.Path('/home/adrien/.norva/global-featured-language-20261004')
q="""with featured as materialized (
 select f.user_id,f.title_id,f.seen_at,v.id variant_id,v.source_id,v.item_type
 from catalog_featured_language_titles f join cloud_title_variants v on v.title_id=f.title_id and v.user_id=f.user_id
 join cloud_catalog_visible_sources s on s.id=v.source_id and s.user_id=v.user_id
 join cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id and h.active_generation_id=v.generation_id
 where f.expires_at>now()
) select jsonb_build_object('at',clock_timestamp(),'featuredVariants',(select count(*) from featured),
 'metadataSincePriority',(select count(*) from catalog_provider_audio_metadata_retries q join featured f on f.variant_id=q.variant_id where q.updated_at>=f.seen_at),
 'metadataCodes',(select jsonb_object_agg(last_code,n) from (select coalesce(q.last_code,'none') last_code,count(*) n from catalog_provider_audio_metadata_retries q join featured f on f.variant_id=q.variant_id where q.updated_at>=f.seen_at group by 1)x),
 'intakeSincePriority',(select count(*) from catalog_vod_language_intake q join featured f on f.variant_id=q.variant_id where q.updated_at>=f.seen_at),
 'intakeCodes',(select jsonb_object_agg(code,n) from (select coalesce(q.last_code,'none') code,count(*) n from catalog_vod_language_intake q join featured f on f.variant_id=q.variant_id where q.updated_at>=f.seen_at group by 1)x),
 'strictSincePriority',(select count(*) from catalog_file_audio_validation_jobs q join featured f on f.variant_id=q.variant_id where q.last_provider_progress_at>=f.seen_at),
 'visibleMovieIdentified',(select count(*) from featured where item_type='movie' and catalog_movie_audio_identified(user_id,source_id,variant_id)));"""
r=c['sql'](q)[0]
start=time.monotonic();c['sql']("select jsonb_build_object('count',count(*)) from list_due_catalog_file_audio_validation_jobs(2);");r['strictSelectorSeconds']=round(time.monotonic()-start,3)
logs=subprocess.check_output(['docker','logs','norva-language-campaign'],stderr=subprocess.STDOUT,text=True)
events=[]
for line in logs.splitlines():
 try:events.append(json.loads(line))
 except ValueError:pass
r['dispatcherEvents']={'count':len(events),'httpErrors':sum('httpError' in e for e in events),'discoveryFailures':sum(e.get('event')=='source-discovery-unavailable' for e in events),'codes':dict(collections.Counter(e.get('skipped') or e.get('code') or 'none' for e in events))}
(root/'featured-progress.safe.json').write_text(json.dumps(r));print(json.dumps(r))
