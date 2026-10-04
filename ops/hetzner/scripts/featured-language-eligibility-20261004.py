"""Read-only eligibility and observed progress; no leases or provider requests."""
import collections,datetime,json,pathlib,runpy
c=runpy.run_path('/home/adrien/.norva/language-campaign-20261003.py')
root=pathlib.Path('/home/adrien/.norva/global-featured-language-20261004')
q="""with featured as materialized (
 select f.user_id,f.title_id,f.seen_at,v.id variant_id,v.source_id,v.item_type,v.external_id,
 coalesce(i.identity_id::text,'source:'||s.id::text) identity_key
 from catalog_featured_language_titles f join cloud_title_variants v on v.title_id=f.title_id and v.user_id=f.user_id
 join cloud_catalog_visible_sources s on s.id=v.source_id and s.user_id=v.user_id
 join cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id and h.active_generation_id=v.generation_id
 left join catalog_source_provider_identities i on i.source_id=s.id and i.user_id=s.user_id and i.verified_at is not null
 where f.expires_at>now()
), movies as materialized(select * from featured where item_type='movie' and not catalog_movie_audio_identified(user_id,source_id,variant_id)),
jobs as materialized(select distinct j.id,j.state,j.error_code last_code,j.quarantined_at,j.retry_at next_attempt_at,j.last_provider_progress_at,f.seen_at
 from catalog_file_audio_validation_jobs j join movies f on j.identity_key=f.identity_key and j.item_type='movie' and j.external_id=f.external_id)
select jsonb_build_object('at',clock_timestamp(),'featuredUnknownMovies',(select count(*) from movies),
'strictJobs',(select jsonb_agg(x) from (select state,coalesce(last_code,'none') code,count(*) n,count(*) filter(where quarantined_at is not null) quarantined,count(*) filter(where next_attempt_at>now()) delayed,count(*) filter(where last_provider_progress_at>=seen_at) progressed_since_priority from jobs group by 1,2)x),
'intakeStates',(select jsonb_agg(x) from (select coalesce(q.state,'unclaimed') state,coalesce(q.last_code,'none') code,count(*) n,count(*) filter(where q.next_attempt_at>now()) delayed from movies f left join catalog_vod_language_intake q on q.variant_id=f.variant_id group by 1,2)x),
'metadataStates',(select jsonb_agg(x) from (select coalesce(q.last_code,'none') code,count(*) n,count(*) filter(where q.next_attempt_at>now()) delayed from movies f left join catalog_provider_audio_metadata_retries q on q.variant_id=f.variant_id group by 1)x),
'seriesInventorySincePriority',(select count(*) from catalog_series_inventory_state q join featured f on q.user_id=f.user_id and q.source_id=f.source_id and q.parent_series_id=f.external_id where f.item_type='series' and q.updated_at>=f.seen_at));"""
try: result=c['sql'](q)[0]
except RuntimeError:
 # Read schema without printing tenant data if a diagnostic field has drifted.
 print(json.dumps({'diagnostic':'schema_mismatch'}));raise
state=json.loads((c['ROOT']/'state/state.json').read_text());manifest=json.loads((c['ROOT']/'manifest.json').read_text());now=datetime.datetime.now(datetime.timezone.utc).timestamp()*1000
result['originalSourceLanes']=[{'source':s['label'],'blockedForSeconds':max(0,round((state['sources'][s['id']].get('blockedUntil',0)-now)/1000)),
 'lanes':{k:{'nextInSeconds':max(0,round((v['nextAt']-now)/1000)),'lastAt':v.get('lastAt'),'result':v.get('lastResult')} for k,v in state['sources'][s['id']]['lanes'].items()}} for s in manifest['sources']]
(root/'eligibility.safe.json').write_text(json.dumps(result));print(json.dumps(result))

