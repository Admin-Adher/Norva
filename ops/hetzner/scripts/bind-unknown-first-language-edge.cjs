// Git-bound candidate plus the five exact, read-only production baseline files.
const fs=require('node:fs'), path=require('node:path'), {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const git=process.env.NORVA_RELEASE_GIT||'git';
const baseline=path.resolve(process.argv[2]||''), output=path.resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3]||!fs.statSync(baseline).isDirectory()||!fs.statSync(output).isDirectory())throw Error('Existing baseline and artifact directories required');
const before={
  '_shared/provider-catalog-language.mjs':'a1decb43db87f9dec85db770eab0b47096d838d8535d91a16ebbbf6b8825d39e',
  '_shared/selection-provider-languages.mjs':'22f596f37f74375e7413adb09b6f8b12be7e468ea3fc0d428c8f0221d20ea152',
  '_shared/xtream-language-declarations.mjs':'724cb343e077fa037c906d237b77ff7e5cd46bf6d2603284c0ae7c2f7538a316',
  '_shared/owned-provider-language-declarations.mjs':null,
  'norva-catalog/index.ts':'6f209a4ddfc94fdda2e180a6bc63f61334a05b177a080a38f84e2d53e212425f',
  'norva-playback/index.ts':'2d661fdb6a71f85bf1e654e74d61ac1c128efb2801a5339883abed62254f3b46',
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const commit=execFileSync(git,['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const operator='ops/hetzner/scripts/deploy-unknown-first-language-edge.py';
const files=Object.keys(before).map(name=>'supabase/functions/'+name);
execFileSync(git,['diff','--exit-code','HEAD','--',operator,...files]);
const cfg={schema:1,commit,sqlCommit:'ff8a25ead75088ff83eea216c94c54c3efab1e18',edgeFiles:{}};
for(const [name,digest]of Object.entries(before)){
  const file='supabase/functions/'+name, local=path.join(baseline,file);
  if(digest===null){if(fs.existsSync(local))throw Error('New helper already exists in baseline');}
  else if(!fs.statSync(local).isFile()||fs.lstatSync(local).isSymbolicLink()||sha(fs.readFileSync(local))!==digest)throw Error('Audited baseline drift: '+name);
  const candidate=execFileSync(git,['show',commit+':'+file],{maxBuffer:2*1024*1024});
  cfg.edgeFiles[name]=[digest,sha(candidate)];
}
const directory=fs.mkdtempSync(path.join(output,'unknown-first-edge-release-'));
// git archive otherwise applies Windows core.autocrlf to tracked text, while
// the binding deliberately hashes Git blobs. Preserve those exact LF bytes.
execFileSync(git,['-c','core.autocrlf=false','archive','--format=tar','--output='+path.join(directory,'candidate.tar'),commit,'--',...files]);
const tar=process.platform==='win32'?'C:/Windows/System32/tar.exe':'tar';
execFileSync(tar,[
  '-cf',path.join(directory,'base.tar'),'-C',baseline,...Object.keys(before).filter(name=>before[name]!==null).map(name=>'supabase/functions/'+name)]);
for(const kind of ['base','candidate'])for(const [name,pair]of Object.entries(cfg.edgeFiles)){
  const expected=pair[kind==='base'?0:1];if(expected===null)continue;
  const extracted=execFileSync(tar,['-xOf',path.join(directory,kind+'.tar'),'supabase/functions/'+name],{maxBuffer:2*1024*1024});
  if(sha(extracted)!==expected)throw Error('Archive byte mismatch: '+kind+'/'+name);
}
const bytes=execFileSync(git,['show',commit+':'+operator]);cfg.operatorSha256=sha(bytes);
fs.writeFileSync(path.join(directory,path.basename(operator)),bytes,{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(directory,'release-config.private.json'),JSON.stringify(cfg,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({directory,commit,edgeFiles:files.length,productionWrites:0}));
