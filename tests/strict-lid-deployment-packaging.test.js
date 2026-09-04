const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('strict deployment preserves private staging without unreadable non-root runtime files',()=>{
 const source=fs.readFileSync('ops/hetzner/scripts/deploy-strict-lid-20260904.py','utf8');
 assert.ok(source.includes('os.umask(0o077)'));
 assert.ok(source.includes('COPY --chmod=0644'));
 assert.ok(source.includes("(root/'functions'/rel).chmod(0o644)"));
 assert.ok(source.includes("'--user',gw['Config']['User'] or '0'"));
 assert.ok(source.includes("assert h.get(field)==0"));
 assert.ok(source.includes("h.get('languageWavExtraction',{}).get('active')==0"));
 assert.ok(source.includes("left=sorted(left,key="));
});
