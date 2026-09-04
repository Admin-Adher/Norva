const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260904200000_admin_source_count_ranges.sql'),'utf8');
test('inclusive range filtering applies to total, page and export before pagination',()=>{
  assert.equal((sql.match(/src.n >= v_source_min/g)||[]).length,3);
  assert.equal((sql.match(/src.n <= v_source_max/g)||[]).length,3);
  assert.equal((sql.match(/if not public.is_admin\(\)/g)||[]).length,2);
  assert.equal((sql.match(/v_source_min > v_source_max/g)||[]).length,2);
  assert.match(sql,/\^range:\[0-9\]\{0,6\}:\[0-9\]\{0,6\}\$/);
  assert.doesNotMatch(sql,/drop function/i);
  assert.match(sql,/notify pgrst, 'reload schema'/);
});
