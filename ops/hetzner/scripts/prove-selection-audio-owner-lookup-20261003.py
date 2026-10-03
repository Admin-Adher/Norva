import json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-progress-20261003')
def sql(q):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=105)
 if p.returncode:raise RuntimeError(p.stderr[-600:])
 return p.stdout.strip()
q="""begin;set local statement_timeout='90s';set local request.jwt.claim.role='service_role';
create temporary table old_pairs on commit drop as
select distinct j.external_id,j.url_sha256,v.user_id,v.source_id
from public.catalog_selection_audio_jobs j join public.cloud_catalog_visible_title_variants v
 on v.item_type='movie' and v.external_id=j.external_id
join public.cloud_media_items m on m.id=v.media_item_id and m.user_id=v.user_id and m.source_id=v.source_id
 and m.generation_id=v.generation_id and m.item_type='movie' and m.available
where public.norva_selection_source_identity_valid(v.source_id,v.user_id)
 and encode(sha256(convert_to(v.playback_hint->>'targetUrl','UTF8')),'hex')=j.url_sha256
 and m.playback_hint->>'targetUrl'=v.playback_hint->>'targetUrl';
create temporary table new_pairs on commit drop as
select distinct j.external_id,j.url_sha256,v.user_id,v.source_id
from public.catalog_selection_audio_jobs j join public.selection_shared_runtime_physical_variants v
 on v.item_type='movie' and v.external_id=j.external_id
join public.cloud_media_items m on m.id=v.media_item_id and m.user_id=v.user_id and m.source_id=v.source_id
 and m.generation_id=v.generation_id and m.item_type='movie' and m.available
where public.norva_selection_source_identity_valid(v.source_id,v.user_id)
 and encode(sha256(convert_to(v.playback_hint->>'targetUrl','UTF8')),'hex')=j.url_sha256
 and m.playback_hint->>'targetUrl'=v.playback_hint->>'targetUrl';
select jsonb_build_object('allJobs',(select count(*) from public.catalog_selection_audio_jobs),
 'oldPairs',(select count(*) from old_pairs),'newPairs',(select count(*) from new_pairs),
 'removed',(select count(*) from(select * from old_pairs except select * from new_pairs)x),
 'added',(select count(*) from(select * from new_pairs except select * from old_pairs)x));rollback;"""
started=time.time();proof=json.loads(sql(q));assert proof['removed']==0 and proof['added']==0,'Owner equivalence failed'
proof['proofSeconds']=round(time.time()-started,3)
migration=(ROOT/'supabase/migrations/20261003022000_selection_audio_physical_owner_lookup.sql').read_text()
sql(migration.replace('commit;','rollback;'))
sql(migration+"notify pgrst,'reload schema';")
started=time.time();sample=sql("set request.jwt.claim.role='service_role';select jsonb_array_length(public.selection_audio_job_owners(external_id,url_sha256)) from public.catalog_selection_audio_jobs where profile<>'{}'::jsonb limit 1;")
proof['indexedLookupSeconds']=round(time.time()-started,3);proof['lookupOwnerCount']=int(sample)
(ROOT/'owner-lookup.safe.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof))
