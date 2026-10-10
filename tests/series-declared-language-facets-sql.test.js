'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
let PGlite;try{({PGlite}=require('@electric-sql/pglite'));}catch(error){if(process.env.NORVA_REQUIRE_SELECTION_SQL==='1')throw error;}
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261010111000_series_declared_language_facets.sql'),'utf8');
const u=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('series declaration optimization preserves exact ownership, membership and evidence precedence', {skip:!PGlite},async()=>{
 const db=new PGlite();const owner=u(1),source=u(2),generation=u(3),title=u(4),variant=u(5),identity=u(6);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table cloud_catalog_visible_sources(id uuid,user_id uuid,enabled boolean);
   create table variants(id uuid,user_id uuid,source_id uuid,generation_id uuid,title_id uuid,item_type text,external_id text,visible boolean);
   create view cloud_catalog_visible_title_variants as select * from variants where visible;
   create table cloud_titles(id uuid,user_id uuid,item_type text);
   create table cloud_source_lifecycle(source_id uuid,user_id uuid,config_revision int,visibility_epoch int);
   create table catalog_source_provider_identities(user_id uuid,source_id uuid,identity_id uuid,verified_at timestamptz);
   create table catalog_owned_language_declarations(variant_id uuid,user_id uuid,source_id uuid,generation_id uuid,config_revision int,source_visibility_epoch int,provider_identity_id uuid,item_type text,file_external_id text,payload_fingerprint text,audio_languages text[]);
   create table catalog_series_episode_memberships(user_id uuid,source_id uuid,generation_id uuid,parent_variant_id uuid,parent_title_id uuid,parent_series_id text,provider_identity_id uuid,episode_id text,payload_fingerprint text);
   create table cloud_title_file_language_observations(user_id uuid,title_id uuid,variant_id uuid,file_external_id text,audio_observed boolean,audio_languages text[]);
   create table episode_evidence(user_id uuid,source_id uuid,variant_id uuid,language text);
   create function cloud_catalog_xtream_series_episode_audio_evidence(p_user_id uuid,p_source_id uuid) returns table(variant_id uuid,language text) language sql stable as $$select variant_id,language from public.episode_evidence where user_id=p_user_id and(p_source_id is null or source_id=p_source_id)$$;
   create function catalog_owned_language_metadata_enabled_for_source(p_user_id uuid,p_source_id uuid) returns boolean language sql stable as $$select enabled from public.cloud_catalog_visible_sources where user_id=p_user_id and id=p_source_id$$;
   create function norva_canonical_language_code(value text) returns text language sql immutable as $$select case when value in('en','fr','de')then value when value='eng'then 'en' else null end$$;
   insert into cloud_catalog_visible_sources values('${source}','${owner}',true);
   insert into variants values('${variant}','${owner}','${source}','${generation}','${title}','series','parent',true);
   insert into cloud_titles values('${title}','${owner}','series');
   insert into cloud_source_lifecycle values('${source}','${owner}',1,1);
   insert into catalog_source_provider_identities values('${owner}','${source}','${identity}',now());
   insert into catalog_owned_language_declarations values('${variant}','${owner}','${source}','${generation}',1,1,'${identity}','episode','ep-1','proof',array['en','eng','fr','invalid','yue']);
   insert into catalog_series_episode_memberships values('${owner}','${source}','${generation}','${variant}','${title}','parent','${identity}','ep-1','proof');
  `);
  await db.exec(migration);
  const languages=async(o=owner,s='null')=>(await db.query(`select language from cloud_catalog_owned_audio_declarations_scoped('${o}',${s},'series') order by language`)).rows.map(r=>r.language);
  assert.deepEqual(await languages(),['en','fr','yue']);
  assert.deepEqual(await languages(owner,`'${source}'`),['en','fr','yue']);
  assert.deepEqual(await languages(u(99)),[]);assert.deepEqual(await languages(owner,`'${u(99)}'`),[]);
  const rejected=async(statement)=>{await db.exec('begin;'+statement);assert.deepEqual(await languages(),[],statement);await db.exec('rollback;');};
  for(const column of ['user_id','source_id','generation_id','parent_variant_id','parent_title_id','provider_identity_id'])await rejected(`update catalog_series_episode_memberships set ${column}='${u(99)}';`);
  for(const column of ['parent_series_id','episode_id','payload_fingerprint'])await rejected(`update catalog_series_episode_memberships set ${column}='different';`);
  await rejected('update variants set visible=false;');
  await rejected('update cloud_catalog_visible_sources set enabled=false;');
  await rejected('update cloud_source_lifecycle set config_revision=2;');await rejected('update cloud_source_lifecycle set visibility_epoch=2;');
  await rejected('update catalog_source_provider_identities set verified_at=null;');
  await rejected(`insert into episode_evidence values('${owner}','${source}','${variant}','de');`);
  await rejected(`insert into cloud_title_file_language_observations values('${owner}','${title}','${variant}','parent',true,array['eng']);`);
  await db.exec(`insert into cloud_title_file_language_observations values('${owner}','${title}','${variant}','other-episode',true,array['de']);`);
  assert.deepEqual(await languages(),['en','fr','yue'],'unrelated file cannot veto declaration');
  await db.exec(`update cloud_title_file_language_observations set file_external_id='parent',audio_languages=array['invalid'];`);
  assert.deepEqual(await languages(),['en','fr','yue'],'unidentified observation does not invent a language');
  // The existing movie branch is unchanged and still binds the exact file.
  await db.exec(`delete from cloud_title_file_language_observations;update variants set item_type='movie',external_id='ep-1';update cloud_titles set item_type='movie';update catalog_owned_language_declarations set item_type='movie';`);
  assert.deepEqual((await db.query(`select language from cloud_catalog_owned_audio_declarations_scoped('${owner}',null,'movie') order by language`)).rows.map(r=>r.language),['en','fr','yue']);
  assert.equal((await db.query(`select has_function_privilege('authenticated','norva_catalog_series_owned_audio_declarations(uuid,uuid)','EXECUTE') allowed`)).rows[0].allowed,false);
 }finally{await db.close();}
});
