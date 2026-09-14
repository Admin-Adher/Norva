const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
test('Git language release archive stays byte exact with a Windows CRLF checkout',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'norva-archive-bytes-'));
  const git=process.env.NORVA_RELEASE_GIT||(process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git');
  const run=args=>execFileSync(git,args,{cwd:root,stdio:['ignore','pipe','pipe']});
  try{
    run(['init','-q']);run(['config','core.autocrlf','true']);
    const bytes=Buffer.from('export const language = "fa";\nexport const owned = true;\n');
    fs.writeFileSync(path.join(root,'fixture.mjs'),bytes);run(['add','fixture.mjs']);
    run(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
    run(['-c','core.autocrlf=false','archive','--format=tar','--output=candidate.tar','HEAD','--','fixture.mjs']);
    const actual=execFileSync(process.platform==='win32'?'C:/Windows/System32/tar.exe':'tar',['-xOf',path.join(root,'candidate.tar'),'fixture.mjs']);
    assert.deepEqual(actual,bytes);
  }finally{
    assert.ok(path.isAbsolute(root)&&path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('norva-archive-bytes-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
test('language binder uses byte-stable Git export and checks both archive payloads',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../ops/hetzner/scripts/bind-unknown-first-language-edge.cjs'),'utf8');
  assert.match(source,/'-c','core\.autocrlf=false','archive'/);
  assert.match(source,/for\(const kind of \['base','candidate'\]\)/);
  assert.match(source,/if\(sha\(extracted\)!==expected\)throw Error/);
});
