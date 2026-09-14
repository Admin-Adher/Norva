// Create immutable, Git-bound operator artifacts. No remote/production actions.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const git=process.env.NORVA_RELEASE_GIT||'git';
if(!process.argv[2]||process.argv.length!==3)throw Error('Existing private output directory required');
const output=path.resolve(process.argv[2]);
if(!fs.statSync(output).isDirectory())throw Error('Output directory required');
const file='ops/hetzner/scripts/deploy-owned-language-maintenance-60m-20260914.py';
execFileSync(git,['diff','--exit-code','HEAD','--',file]);
const commit=execFileSync(git,['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const bytes=execFileSync(git,['show',commit+':'+file]);
const directory=fs.mkdtempSync(path.join(output,'owned-language-maintenance-60m-'));
const binding={operatorCommit:commit,operatorSha256:createHash('sha256').update(bytes).digest('hex'),
  sourceCommit:'d7dacab268c7ad1b10f349811dadb6a38b766efa',maxPauseSeconds:3600,
  authorization:'pause-planned-jobs-at-most-60m-no-cancellation'};
fs.writeFileSync(path.join(directory,path.basename(file)),bytes,{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(directory,'maintenance-binding.private.json'),JSON.stringify(binding,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({directory,...binding,productionWrites:0}));
