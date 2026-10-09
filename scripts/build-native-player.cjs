'use strict';
const {spawnSync}=require('node:child_process');const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'), output=path.join(root,'native-player');
if(process.platform!=='win32')throw Error('The Windows native player is built on Windows.');
const sdk=process.env.NORVA_DOTNET || 'dotnet';
const result=spawnSync(sdk,['publish',path.join(root,'clients/windows-player/Norva.NativePlayer.csproj'),'-c','Release','-p:RestoreLockedMode=true','-o',output],{cwd:root,stdio:'inherit',shell:false,env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});
if(result.status!==0)throw Error('Native player compilation failed. Install the SDK pinned by the Windows workflow.');
for(const file of ['Norva.NativePlayer.exe','libvlc/win-x64/libvlc.dll','norva-theme.css']){
 if(!fs.existsSync(path.join(output,file)))throw Error('Native runtime incomplete: '+file);
}
fs.copyFileSync(path.join(root,'clients/windows-player/THIRD-PARTY-NOTICES.md'),path.join(output,'THIRD-PARTY-NOTICES.md'));
fs.cpSync(path.join(root,'clients/windows-player/licenses'),path.join(output,'licenses'),{recursive:true});
fs.copyFileSync(path.join(root,'clients/windows-player/packages.lock.json'),path.join(output,'packages.lock.json'));
fs.copyFileSync(path.join(root,'clients/windows-player/source-manifest.json'),path.join(output,'source-manifest.json'));
const nuget=process.env.NUGET_PACKAGES||path.join(require('node:os').homedir(),'.nuget/packages');
for(const [pkg,files] of Object.entries({'microsoft.netcore.app.runtime.win-x64':['LICENSE.TXT','THIRD-PARTY-NOTICES.TXT'],'microsoft.windowsdesktop.app.runtime.win-x64':['LICENSE']})) {
 const base=path.join(nuget,pkg,'10.0.12'),destination=path.join(output,'licenses',pkg);fs.mkdirSync(destination,{recursive:true});
 for(const file of files)fs.copyFileSync(path.join(base,file),path.join(destination,file));
}
// This release is x64. Never ship unused x86/ARM copies of the decoder.
for(const arch of ['win-x86','win-arm64']) {
 const redundant=path.resolve(output,'libvlc',arch);
 if(!redundant.startsWith(path.resolve(output)+path.sep))throw Error('Invalid runtime cleanup path');
 fs.rmSync(redundant,{recursive:true,force:true});
}
// Reuse the product's reviewed translations instead of a separate native palette of words.
const messages = {};
for(const name of ['web.json','web-extra.json','web-tail.json','native.json','reviewed.json']) {
 for(const [key,value] of Object.entries(JSON.parse(fs.readFileSync(path.join(root,'i18n',name),'utf8')))) messages[key]={...messages[key],...value};
}
const keys={back:'ui_web_76900f1bfd16',play:'ui_web_436e61016e26',pause:'ui_web_42dd586c06d6',fullscreen:'ui_web_c461dbb2bab7',audio:'ui_web_f3161deff512',subtitles:'ui_web_b4463f5175c6',off:'ui_web_ca7981b46ecf',failure:'ui_web_0535388758c1',volume:'Volume',position:'ui_web_c12ff673ae98',preparing:'Preparing playback…'};
const labels={};
for(const [label,key] of Object.entries(keys)){
 const entry=messages[key];if(!entry?.en)throw Error('Missing native translation: '+label);
 labels[label]=Object.fromEntries(Object.entries(entry).filter(([lang,text])=>/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(lang)&&typeof text==='string'));
}
fs.writeFileSync(path.join(output,'norva-labels.json'),JSON.stringify(labels));
console.log('Native Windows media runtime compiled and packaged.');
