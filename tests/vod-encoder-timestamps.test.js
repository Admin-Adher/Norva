'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {videoEncoderTimestampArgs}=require('../services/media-gateway/src/video-encoder');

test('finite VOD encoding uses the TS transport clock without changing frame cadence',()=>{
    assert.deepEqual(videoEncoderTimestampArgs(true,false),['-enc_time_base:v','1:90000']);
    const args=videoEncoderTimestampArgs(true,false);
    assert.equal(args.includes('-r'),false);
    assert.equal(args.includes('-vf'),false);
    assert.equal(args.includes('-copyts'),false);
});
test('copy mode, live and unspecified contexts keep their existing clock',()=>{
    for(const [encode,live] of [[false,false],[false,true],[true,true],[true,undefined],[undefined,false]]){
        assert.deepEqual(videoEncoderTimestampArgs(encode,live),[]);
    }
});
test('Gateway attaches precise timestamps to its actual HLS output graph',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    assert.match(source,/const hlsOutputArgs = \[\s*'-fps_mode', 'passthrough',\s*\.\.\.videoEncoderTimestampArgs\(encodeVideo, isLiveSession\(session\)\)/);
    assert.match(source,/videoEncoderTimestampArgs,[\s\S]{0,40}require\('\.\/video-encoder'\)/);
});

test('both cache graphs version encoded clocks while preserving copy cache keys',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    for(const name of ['sharedMediaCachePipelineBuildForSession','mkvCompleteHlsCachePipelineBuildForSession']){
        const start=source.indexOf(`function ${name}(`);
        const end=source.indexOf('\nfunction ',start+1);
        assert.ok(start>0&&end>start);
        const fn=vm.runInNewContext(`${source.slice(start,end)}\n${name}`,{
            MKV_COMPLETE_HLS_CACHE_PIPELINE_BUILD:'mkv-complete-hls-mpegts-v6',
            EXACT_MATROSKA_H264_HLS_TARGET_SECONDS:2,
            videoModeForSession:s=>s.videoMode,
            audioModeForSession:()=> 'transcode',
        });
        const context={eligible:true,audioTopology:{kind:'single'},subtitleTopology:{renditions:[]}};
        const copy=fn({videoMode:'copy'},context);
        const encoded=fn({videoMode:'encode'},context);
        assert.equal(copy,'mkv-complete-hls-mpegts-v6:video-copy:audio-transcode:subtitles-webvtt-0:target-4');
        assert.equal(encoded,'mkv-complete-hls-mpegts-v6:video-encode:clock-90khz-v1:audio-transcode:subtitles-webvtt-0:target-4');
        assert.match(fn({videoMode:'copy'},{...context,audioTopology:{kind:'multi-audio',audioRenditions:[{},{}]}}),/:video-encode:clock-90khz-v1:audio-multi-aac-2:/);
    }
});
