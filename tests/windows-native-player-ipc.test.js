'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {trustedSender}=require('../desktop/native-player-ipc');

test('native IPC is restricted to the exact catalogue main frame and origin',()=>{
    const mainFrame={url:'https://norva.tv/app'},webContents={mainFrame};
    const window={isDestroyed:()=>false,webContents};
    const event={sender:webContents,senderFrame:mainFrame};
    assert.equal(trustedSender(event,window,'https://norva.tv'),true);
    assert.equal(trustedSender({...event,sender:{}},window,'https://norva.tv'),false);
    assert.equal(trustedSender({...event,senderFrame:{url:mainFrame.url}},window,'https://norva.tv'),false);
    mainFrame.url='https://other.test/';assert.equal(trustedSender(event,window,'https://norva.tv'),false);
    assert.equal(trustedSender(event,{...window,isDestroyed:()=>true},'https://other.test'),false);
});

function preload(origin){
    let exposed;
    const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{exposed=value;}},ipcRenderer:{invoke:async()=>{},on(){},removeListener(){}}};
    vm.runInNewContext(fs.readFileSync('preload.js','utf8'),{
        require:()=>electron,location:{origin},console,
        process:{argv:['--norva-transcoder=http://127.0.0.1:1234','--norva-native-player=1','--norva-native-origin=https://norva.tv']}
    });
    return exposed;
}
test('desktop pilot exposes only finite VOD capability on the approved page',()=>{
    const player=preload('https://norva.tv').nativePlayer;
    for(const extension of ['mkv','mp4','mpeg'])assert.equal(player.supportsPlayback('movie',extension),true);
    assert.equal(player.supportsPlayback('series','mkv'),true);
    assert.equal(player.supportsPlayback('live','ts'),false);
    for(const extension of ['m3u8','mpd',''])assert.equal(player.supportsPlayback('movie',extension),false);
    assert.equal(player.privateMediaCacheProtocol(),0);
    assert.equal(preload('https://other.test').nativePlayer,undefined);
});
