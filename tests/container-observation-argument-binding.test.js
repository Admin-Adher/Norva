'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260912121500_container_observation_argument_binding.sql'), 'utf8');
const previous = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260823173000_catalog_generation_legacy_routine_fences.sql'), 'utf8').replace(/\r\n/g,'\n');
function wrapper(sql) {
  const start = sql.indexOf('create or replace function public.record_catalog_file_container_observation(');
  const end = sql.indexOf('$function$;', start);
  assert.ok(start >= 0 && end > start);
  return sql.slice(start,end+'$function$;'.length);
}
const call = /v_result:=public\.record_catalog_file_container_observation\([\s\S]*?\);/;
test('container correction forwards all ten legacy arguments by name, including the three distinct UUID roles',()=>{
  const match = wrapper(migration).match(call);
  assert.ok(match);
  const params = ['playback_session_id','user_id','source_id','item_type','external_id','declared_container','observed_container','evidence','expected_media_item_id','expected_media_item_updated_at'];
  const pairs = [...match[0].matchAll(/p_(\w+)\s*=>\s*p_(\w+)/g)];
  assert.deepEqual(pairs.map(m=>m[1]),params);
  assert.ok(pairs.every(m=>m[1]===m[2]));
});
test('the patch changes only forwarding, preserving ownership, generation fencing and item CAS',()=>{
  assert.equal(wrapper(migration).replace(call,'FORWARD'),wrapper(previous).replace(call,'FORWARD'));
  assert.match(migration,/revoke all on function[\s\S]+from public,anon,authenticated/);
  assert.match(migration,/grant execute on function[\s\S]+to service_role/);
  assert.doesNotMatch(migration,/update public\.|delete from|truncate|drop table/i);
});
