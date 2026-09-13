'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8').replace(/\r\n/g,'\n');
const sql=read('supabase/migrations/20260913053000_scoped_language_capture_jobs.sql');
const edge=read('supabase/functions/norva-playback/index.ts');

test('scoped SQL changes only the existing capture rollout gate, never acquisition or evidence guards',()=>{
    assert.match(sql,/old:='if not public\.catalog_language_capture_pipeline_enabled\(\) then return null; end if;'/);
    assert.match(sql,/Capture rollout gate drifted/);
    assert.match(sql,/catalog_language_capture_pipeline_enabled_for_job\(p_job_id\)/);
    assert.doesNotMatch(sql,/update public\.(?:admin_feature_flags|catalog_file_audio_validation_jobs)|delete from public\.(?:provider_|catalog_file_audio_validation_jobs)/i);
});
test('scoped approvals remain service-only, internal, profile-bound, expiring and at most twenty',()=>{
    assert.match(sql,/force row level security/);
    assert.match(sql,/revoke all on public\.catalog_language_capture_job_pilots from public,anon,authenticated,service_role/);
    assert.equal((sql.match(/perform public\.norva_credential_require_service_role\(\)/g)||[]).length,2);
    assert.match(sql,/expires_at <= created_at \+ interval '1 hour'/);
    assert.match(sql,/where expires_at>v_now\)>=20/);
    assert.match(sql,/prior\.expires_at=p_expires_at/);
    assert.match(sql,/internal\.user_id=j\.requested_by/);
    assert.match(sql,/p\.profile_fingerprint=j\.profile_fingerprint/);
    assert.match(sql,/j\.quarantined_at is null/);
});
test('actual Edge consults the claimed job before local lookup and existing provider checks',()=>{
    const start=edge.indexOf('const captureOptions = { db, jobId, leaseOwner, claim, current, targetUrl');
    const end=edge.indexOf('const providerAccountScope =',start);
    const source=edge.slice(start,end);
    assert.match(source,/"catalog_language_capture_pipeline_enabled_for_job", \{ p_job_id: jobId \}/);
    assert.ok(source.indexOf('catalog_language_capture_pipeline_enabled_for_job')<source.indexOf('requestLanguageCaptureWindow'));
    assert.doesNotMatch(source,/catalog_language_capture_pipeline_enabled"/);
});
