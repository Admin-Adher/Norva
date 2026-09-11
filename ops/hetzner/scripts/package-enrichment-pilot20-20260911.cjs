'use strict';
// Local, immutable release payload from one Git commit. No deployment/network.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {collectSelectionModules,packageSelectionRelease}=require('./package-selection-audio-release-20260911.cjs');
const root=path.resolve(__dirname,'../../..');
const git=process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git';
const revision=ref=>cp.execFileSync(git,['rev-parse',ref],{cwd:root,encoding:'utf8'}).trim();
const base='d86db0e13871f8d5b43d9faf67516b6b2cd0a969';
const gateway=['index','language-background-capacity','enrichment-network-admission','selection-enrichment-policy',
    'enrichment-pilot-admission','strict-lid-capture-store','strict-lid-capture-pipeline','strict-lid-multi-extract','strict-lid-range-reuse','passive-lid-capture']
    .map(n=>'services/media-gateway/src/'+n+'.js');
const edge=['norva-playback/index.ts','_shared/automatic-vod-language-fleet.mjs','_shared/selection-audio-gateway.mjs'].map(n=>'supabase/functions/'+n);
const migrations=['20260911182400_enrichment_metadata_lane.sql','20260911191032_strict_lid_capture_handoff.sql',
    '20260911200200_selection_audio_capture_handoff.sql','20260911204152_selection_parallel_capture_admission.sql',
    '20260911204928_exact_file_account_enrichment_admission.sql'].map(n=>'supabase/migrations/'+n);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const normalize=b=>Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'));
const show=(ref,file)=>cp.execFileSync(git,['show',ref+':'+file],{cwd:root,maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});
function build(output) {
    if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('new_absolute_output_required');
    const commit=revision('HEAD'),files={};fs.mkdirSync(output,{mode:0o700});
    const put=(name,bytes)=>{const data=normalize(bytes),target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
        fs.writeFileSync(target,data,{flag:'wx',mode:0o600});files[name]=sha(data);};
    for(const file of [...gateway,...edge,...migrations])put('candidate/'+file,show(commit,file));
    for(const file of [...gateway,...edge]){
        let data;try{data=show(base,file);}catch(error){if(gateway.includes(file)&&!['index.js','language-background-capacity.js'].includes(path.basename(file)))continue;throw error;}
        put('base/'+file,data);
    }
    const modules=collectSelectionModules(root).map(m=>{
        const content=normalize(show(commit,m.source));return {...m,content,bytes:content.length,sha256:sha(content)};
    });
    for(const m of modules){
        if(files['base/'+m.source]||m.source==='ops/hetzner/services/selection-audio-task-pool.mjs')continue;
        put('base/'+m.source,show(base,m.source));
    }
    packageSelectionRelease(path.join(output,'selection'),modules);
    for(const m of modules)files['selection/'+m.target]=m.sha256;
    files['selection/manifest.json']=sha(fs.readFileSync(path.join(output,'selection/manifest.json')));
    fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify({protocol:1,commit,base,files}),{flag:'wx',mode:0o600});
    cp.execFileSync('tar',['-czf',path.join(output,'release.tar.gz'),...Object.keys(files),'release-manifest.json'],{cwd:output});
    console.log(JSON.stringify({commit,files:Object.keys(files).length,bytes:fs.statSync(path.join(output,'release.tar.gz')).size,providerRequests:0}));
}
if(require.main===module)build(process.argv[2]);
module.exports={build};
