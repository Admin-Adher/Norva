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
console.log('Native Windows media runtime compiled and packaged.');
