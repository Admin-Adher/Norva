"""Read-only aggregate global rollout audit. No credential or account ids in output."""
import datetime,hashlib,json,pathlib,runpy,subprocess,time,uuid
c=runpy.run_path('/home/adrien/.norva/language-campaign-20261003.py');root=pathlib.Path('/home/adrien/.norva/global-featured-language-20261004');base=c['ROOT']
q="""set request.jwt.claim.role='service_role';select jsonb_build_object('at',clock_timestamp(),
 'priority',(select jsonb_build_object('owners',count(distinct f.user_id),'titles',count(*),'physicalMovies',count(*) filter(where t.item_type='movie'),'physicalSeries',count(*) filter(where t.item_type='series'),'virtualTitles',count(*) filter(where t.id is null)) from catalog_featured_language_titles f left join cloud_titles t on t.id=f.title_id and t.user_id=f.user_id where expires_at>now()),
 'activeLeases',jsonb_build_object(
 'sourceSchedule',(select count(*) from catalog_enrichment_source_schedule where lease_until>now()),
 'intake',(select count(*) from catalog_vod_language_intake where state='leased' and lease_until>now()),
 'metadata',(select count(*) from catalog_provider_audio_metadata_retries where lease_until>now()),
 'strict',(select count(*) from catalog_file_audio_validation_jobs where state in ('running','finalizing') and lease_expires_at>now()),
 'lastStrictExpiry',(select max(lease_expires_at) from catalog_file_audio_validation_jobs where state in ('running','finalizing') and lease_expires_at>now()),
 'lastIntakeExpiry',(select max(lease_until) from catalog_vod_language_intake where state='leased' and lease_until>now())),
 'paused',(select enabled from admin_feature_flags where key='enrichment_paused'),
 'strictCron',(select active from cron.job where jobid=159));"""
r=c['sql'](q)[0]
discovered=[];after='null'
for page in range(100):
 rows=c['sql']("set request.jwt.claim.role='service_role';select to_jsonb(s) from list_catalog_language_campaign_sources("+after+",128) s;")
 discovered.extend(rows)
 if len(rows)<128:break
 after="'"+str(uuid.UUID(rows[-1]['id']))+"'::uuid"
else:raise RuntimeError('Incomplete discovery audit')
r['discovered']={'sources':len(discovered),'owners':len({s['userId'] for s in discovered})}
r['dispatcher']=json.loads((base/'state/health.json').read_text());state=json.loads((base/'state/state.json').read_text())
original=json.loads((base/'manifest.json').read_text());ids={s['id'] for s in original['sources']}
new=[(k,v) for k,v in state['sources'].items() if k not in ids]
r['outsideOriginal']={'sourcesInState':len(new),'sourcesCalled':sum(v.get('calls',0)>0 for k,v in new),'ownersCalled':len({v.get('userId') for k,v in new if v.get('calls',0)>0}),
 'attempted':sum(v.get('totals',{}).get('attempted',0) for k,v in new),'identifiedReceipts':sum(v.get('totals',{}).get('identified',0) for k,v in new),
 'deferredReceipts':sum(v.get('totals',{}).get('deferred',0) for k,v in new)}
if (root/'dispatcher-before/state.json').exists():
 old=json.loads((root/'dispatcher-before/state.json').read_text());r['countersPreserved']=all(state['sources'][k]['calls']>=v['calls'] for k,v in old['sources'].items())
for name in ['norva-edge-functions','norva-edge-functions-2']:
 info=c['inspect'](name);r[name]={'running':info['State']['Running'],'startedAt':info['State']['StartedAt']}
(root/'runtime.safe.json').write_text(json.dumps(r));print(json.dumps(r))
