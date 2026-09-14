// Export only the committed activation operator and bind its exact Edge release.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const git=process.env.NORVA_RELEASE_GIT||'git';
const output=process.argv[2],edgeCommit=process.argv[3],edgeAttemptDirectory=process.argv[4];
if(process.argv.length!==5||!output||!fs.statSync(output).isDirectory()||!/^[a-f0-9]{40}$/.test(edgeCommit||'')
  ||!/^post-vod-language-edge-20260914-[0-9]{14}$/.test(edgeAttemptDirectory||''))throw Error('Existing output directory, exact Edge commit and scoped attempt required');
const operator='ops/hetzner/scripts/activate-owned-language-metadata-20260914.py';
execFileSync(git,['diff','--exit-code','HEAD','--',operator]);
execFileSync(git,['merge-base','--is-ancestor',edgeCommit,'HEAD']);
const commit=execFileSync(git,['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const bytes=execFileSync(git,['show',commit+':'+operator]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const wrapper=execFileSync(git,['show',edgeCommit+':ops/hetzner/scripts/deploy-post-vod-language-edge-20260914.py']);
if(sha(wrapper)!=='41b1e69ffb9fc126ce4bdecf51aaf05c3aedd148d32f59b515c8954b71ffdc4b')throw Error('Reviewed post-VOD operator changed');
const directory=fs.mkdtempSync(path.join(path.resolve(output),'owned-language-activation-'));
const binding={schema:1,operatorCommit:commit,operatorSha256:sha(bytes),edgeCommit,edgeAttemptDirectory,
  activationDirectory:'post-vod-owned-language-activation-20260914-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)};
fs.writeFileSync(path.join(directory,path.basename(operator)),bytes,{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(directory,'operator-binding.private.json'),JSON.stringify(binding,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({directory,...binding,productionWrites:0}));
