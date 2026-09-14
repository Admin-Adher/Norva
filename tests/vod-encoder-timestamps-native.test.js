'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {resolveVideoEncoderConfig,videoEncoderInputArgs,videoEncoderOutputArgs,videoEncoderTimestampArgs}=require('../services/media-gateway/src/video-encoder');

// Synthetic inputs only, in a network-disabled native test container.
test('VOD clocks preserve fractional/VFR frame intervals and A/V through MKV, MP4 and TS',{
    skip:process.env.NORVA_VOD_CLOCK_NATIVE!=='1',timeout:180000,
},async t=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'norva-vod-clock-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    function run(bin,args,input){
        const r=spawnSync(bin,args,{input,timeout:45000,maxBuffer:16*1024*1024,encoding:'utf8'});
        assert.equal(r.status,0,String(r.stderr).slice(-1600));return r.stdout;
    }
    function probe(file){
        return JSON.parse(run('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,start_time,duration,channels:packet=stream_index,pts_time,dts_time','-of','json',file]));
    }
    const config=resolveVideoEncoderConfig({MEDIA_GATEWAY_VIDEO_ENCODER:'vaapi',MEDIA_GATEWAY_VAAPI_DECODE:'true'});
    const results=[];
    for(const cadence of ['fractional','vfr']){
        const input=path.join(root,cadence+'.mkv');
        run('ffmpeg',['-v','error','-y','-f','lavfi','-i',`testsrc2=size=640x360:rate=${cadence==='fractional'?'24000/1001':'30'}`,
            '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8',
            ...(cadence==='vfr'?['-vf',"select='if(lt(t,4),1,not(mod(n,2)))'",'-fps_mode','vfr']:[]),
            '-map','0:v','-map','1:a','-c:v','libx264','-threads','2','-preset','fast','-bf','3','-g','48','-pix_fmt','yuv420p','-c:a','aac','-ac','2',input]);
        for(const container of cadence==='fractional'?['mkv','mp4','ts']:['mkv']){
            let source=input;
            if(container!=='mkv'){
                source=path.join(root,'fractional.'+container);
                run('ffmpeg',['-v','error','-y','-i',input,'-map','0','-c','copy',source]);
            }
            const sourceProbe=probe(source),sourceVideo=sourceProbe.packets.filter(p=>p.stream_index===0).map(p=>Number(p.pts_time)).sort((a,b)=>a-b);
            for(const hardwareDecode of [false,true])for(const offset of [0,3]){
                const name=`${cadence}-${container}-${hardwareDecode?'hw':'sw'}-${offset}`;
                const output=path.join(root,name+'.ts');
                const piped=container==='mkv'&&offset===0;
                run('ffmpeg',['-v','error','-y',...videoEncoderInputArgs(config,true,{hardwareDecode}),'-fflags','+genpts',
                    ...(offset&&container!=='ts'?['-ss',String(offset)]:[]),'-i',piped?'pipe:0':source,
                    // Match the Gateway's decoded preroll/accurate output trim
                    // for near-origin TS, rather than an imprecise binary seek.
                    ...(offset&&container==='ts'?['-ss',String(offset)]:[]),'-map','0:v:0','-map','0:a:0',
                    ...videoEncoderOutputArgs(config,{hardwareDecode,forceAligned:true,targetSeconds:2}),'-c:a','aac','-ac','2',
                    '-fps_mode','passthrough',...videoEncoderTimestampArgs(true,false),'-f','mpegts',output],piped?fs.readFileSync(source):undefined);
                const out=probe(output),video=out.packets.filter(p=>p.stream_index===0).map(p=>Number(p.pts_time));
                const diffs=video.slice(1).map((v,i)=>v-video[i]);
                assert.ok(diffs.every(d=>d>0.030&&d<0.070),name+' must have genuine, strictly advancing source intervals');
                if(cadence==='fractional')assert.ok(diffs.every(d=>d>0.040&&d<0.043),name+' must not collapse fractional timestamps');
                else assert.ok(diffs.some(d=>d>0.060),name+' must preserve VFR gaps, not duplicate frames into CFR');
                if(offset===0){
                    assert.equal(video.length,sourceVideo.length,name+' must preserve every source frame');
                    for(let i=0;i<video.length;i++)assert.ok(Math.abs((video[i]-video[0])-(sourceVideo[i]-sourceVideo[0]))<0.002,name+' relative PTS at '+i);
                }else{
                    const expected=sourceVideo.filter(v=>v>=sourceVideo[0]+offset-0.001).length;
                    assert.ok(Math.abs(video.length-expected)<=1,name+' must preserve the accurate resume boundary');
                }
                const a=out.streams.find(s=>s.codec_type==='audio'),v=out.streams.find(s=>s.codec_type==='video');
                assert.equal(a.codec_name,'aac');assert.equal(a.channels,2);
                assert.ok(Math.abs(Number(a.start_time)-Number(v.start_time))<0.1,name+' audio/video start');
                results.push({name,frames:video.length,minIntervalMs:Math.min(...diffs)*1000,maxIntervalMs:Math.max(...diffs)*1000});
            }
        }
    }
    console.log(JSON.stringify({network:false,sourceIntervalsPreserved:true,results}));
});
