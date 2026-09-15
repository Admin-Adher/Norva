const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const repo=path.resolve(__dirname,'..');
const binder=path.join(repo,'ops/hetzner/scripts/bind-owned-language-activation.cjs');
const git=process.env.NORVA_RELEASE_GIT||(process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('activation artifact binds committed LF bytes, a precise Edge commit and a fresh scoped directory',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'norva-activation-binding-'));
  const run=args=>execFileSync(git,args,{cwd:root,stdio:['ignore','pipe','pipe']});
  const names=['activate-owned-language-metadata-20260914.py','deploy-post-vod-language-edge-20260914.py'];
  try{
    run(['init','-q']);run(['config','core.autocrlf','true']);
    fs.mkdirSync(path.join(root,'ops/hetzner/scripts'),{recursive:true});
    for(const name of names)fs.copyFileSync(path.join(repo,'ops/hetzner/scripts',name),path.join(root,'ops/hetzner/scripts',name));
    run(['add','--',...names.map(n=>'ops/hetzner/scripts/'+n)]);
    run(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
    const commit=run(['rev-parse','HEAD']).toString().trim();
    const result=JSON.parse(execFileSync(process.execPath,[binder,root,commit,'post-vod-language-edge-20260914-20260914200000'],
      {cwd:root,env:{...process.env,NORVA_RELEASE_GIT:git},encoding:'utf8'}));
    assert.equal(result.edgeCommit,commit);assert.equal(result.operatorCommit,commit);
    assert.equal(result.edgeAttemptDirectory,'post-vod-language-edge-20260914-20260914200000');
    assert.match(result.activationDirectory,/^post-vod-owned-language-activation-20260914-[0-9]{14}$/);
    const actual=fs.readFileSync(path.join(result.directory,names[0]));
    assert.deepEqual(actual,run(['show',commit+':ops/hetzner/scripts/'+names[0]]));
    assert.equal(sha(actual),result.operatorSha256);assert.equal(result.productionWrites,0);
    assert.equal(fs.readFileSync(path.join(result.directory,'operator-binding.private.json'),'utf8').includes('activationDirectory'),true);
    assert.throws(()=>execFileSync(process.execPath,[binder,root,commit,'../foreign'],{cwd:root,stdio:'pipe'}),/scoped attempt required/);
  }finally{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('norva-activation-binding-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('activation and release binder agree on the exact pinned post-VOD wrapper',()=>{
  const bytes=fs.readFileSync(path.join(repo,'ops/hetzner/scripts/deploy-post-vod-language-edge-20260914.py'),'utf8').replace(/\r\n/g,'\n');
  const digest=sha(bytes),source=fs.readFileSync(binder,'utf8');
  const activation=fs.readFileSync(path.join(repo,'ops/hetzner/scripts/activate-owned-language-metadata-20260914.py'),'utf8');
  assert.ok(source.includes(digest));assert.ok(activation.includes("WRAPPER_SHA='"+digest+"'"));
  assert.ok(source.includes("['diff','--exit-code','HEAD','--',operator]"));
  assert.ok(source.includes("['merge-base','--is-ancestor',edgeCommit,'HEAD']"));
});

test('three-hour activation binds only its exact committed wrapper and explicit profile',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'norva-activation-binding-'));
  const run=args=>execFileSync(git,args,{cwd:root,stdio:['ignore','pipe','pipe']});
  const names=['activate-owned-language-metadata-20260914.py','deploy-owned-language-maintenance-3h-20260915.py'];
  try{
    run(['init','-q']);run(['config','core.autocrlf','true']);
    fs.mkdirSync(path.join(root,'ops/hetzner/scripts'),{recursive:true});
    for(const name of names)fs.copyFileSync(path.join(repo,'ops/hetzner/scripts',name),path.join(root,'ops/hetzner/scripts',name));
    run(['add','--',...names.map(n=>'ops/hetzner/scripts/'+n)]);
    run(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
    const commit=run(['rev-parse','HEAD']).toString().trim();
    const result=JSON.parse(execFileSync(process.execPath,[binder,root,commit,'post-vod-language-edge-3h-20260915-20260915020000'],
      {cwd:root,env:{...process.env,NORVA_RELEASE_GIT:git},encoding:'utf8'}));
    assert.equal(result.edgeProfile,'post-vod-3h');assert.equal(result.edgeCommit,commit);
    assert.equal(result.productionWrites,0);
    const wrapper=run(['show',commit+':ops/hetzner/scripts/'+names[1]]);
    assert.ok(fs.readFileSync(binder,'utf8').includes(sha(wrapper)));
    assert.ok(fs.readFileSync(path.join(repo,'ops/hetzner/scripts',names[0]),'utf8').includes("WRAPPER_3H_SHA='"+sha(wrapper)+"'"));
    fs.appendFileSync(path.join(root,'ops/hetzner/scripts',names[1]),'\n# unreviewed change\n');
    run(['add','--','ops/hetzner/scripts/'+names[1]]);
    run(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','changed wrapper']);
    const changed=run(['rev-parse','HEAD']).toString().trim();
    assert.throws(()=>execFileSync(process.execPath,[binder,root,changed,'post-vod-language-edge-3h-20260915-20260915020001'],
      {cwd:root,env:{...process.env,NORVA_RELEASE_GIT:git},stdio:'pipe'}),/Reviewed post-VOD operator changed/);
  }finally{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('norva-activation-binding-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
