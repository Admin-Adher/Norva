/* Test-only real WatchPage menu and TextTrack lifecycle; no provider I/O. */
window.verifyCommittedSubtitles = async function () {
 const assert=(ok,message)=>{if(!ok)throw Error(message)};
 const host=document.querySelector('#qa-host');
 host.innerHTML='<video id="fixture-video" muted></video><div id="fixture-menu"><div id="fixture-list"></div></div><div id="fixture-status" role="status"></div>';
 const p=Object.create(WatchPage.prototype), video=host.querySelector('video');
 const tracks=[{index:2,language:'en',codec:'subrip',extractable:true,forced:true},{index:3,language:'fr',codec:'subrip',extractable:true}];
 Object.assign(p,{video,subtitleTracks:tracks,selectedSubtitleStreamIndex:null,
  currentPlaybackMode:'gateway-session',_committedSubtitleStreams:new Set([2,3]),_committedSubtitleClock:20,
  _hlsOwnsExactSubtitles:false,subtitleOffsetSeconds:0,currentUrl:'https://norva-fixture.test/sessions/test/playlist.m3u8?token=fixture',
  content:{id:'synthetic',playbackPreferences:{subtitle:{source:'off',mode:'off'}}},
  hls:{subtitleTrack:-1,subtitleDisplay:false,subtitleTracks:[],audioTracks:[],audioTrack:-1},
  captionsList:host.querySelector('#fixture-list'),captionsMenu:host.querySelector('#fixture-menu'),subtitleStatusEl:host.querySelector('#fixture-status'),
  _canRequestAiSubtitles:()=>false,burnedSubtitleIntel:()=>null,getOcrableSubtitleTracks:()=>[],
  saveResumeSnapshotThrottled(){},saveProgress(){},
  queueSelectedSubtitleTrackRestart(){throw Error('prepared track restarted video')},
  startSubtitleSessionPolling(engine){engine.lastSuccessfulFetchAt=Date.now();engine.trackEl.track.addCue(new VTTCue(2,5,'Fixture'))}
 });
 p.updateCaptionsTracks();
 for(const streamIndex of [2,3]){
  await p.selectCaptionTrack('probe',streamIndex-2,streamIndex);
  assert(p.selectedSubtitleStreamIndex===streamIndex,'wrong track');
  assert(video.querySelectorAll('track').length===1,'duplicate DOM tracks');
  assert(Array.from(video.textTracks).filter(t=>t.mode==='showing').length===1,'duplicate visible subtitles');
  assert(video.textTracks[video.textTracks.length-1].cues.length===1,'missing committed cue');
  assert(p.hls.subtitleTrack===-1&&!p.hls.subtitleDisplay,'HLS stealing subtitle ownership');
 }
 await p.selectCaptionTrack('off',-1);
 assert(video.querySelectorAll('track').length===0,'off leaves track');
 assert(p._subEngine===null,'off leaves fetch engine');
 clearTimeout(p._subtitleStatusTimer);
 host.textContent='Prepared tracks switched in place; off revoked the managed track.';
 return true;
};
