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

test('embedded playback hides the catalogue without disabling its parent and restores it after drain',async()=>{
    const {EventEmitter}=require('node:events');
    class Controller extends EventEmitter {
        constructor(_exe,options){super();this.options=options;this.unacknowledged=new Set();}
        async open(){return{accepted:true};} stop(){} authorize(){} acknowledge(){} setFullscreen(value){this.fullscreen=value;}
    }
    let controller;const handlers=new Map(),views=[],children=[],full=[];
    const webContents=new EventEmitter();webContents.mainFrame={url:'https://norva.tv/app'};
    webContents.getURL=()=>webContents.mainFrame.url;webContents.send=()=>{};
    const window=new EventEmitter();Object.assign(window,{webContents,isDestroyed:()=>false,
        getNativeWindowHandle:()=>Buffer.from('3412000000000000','hex'),
        contentView:{removeChildView:()=>children.push('remove'),addChildView:()=>children.push('add')},
        setEnabled:()=>assert.fail('parent must remain interactive'),setFullScreen:value=>full.push(value),focus(){}});
    const context={URL,require:name=>name==='./native-player-controller'?{NativePlayerController:class extends Controller{constructor(...a){super(...a);controller=this;}}}:require(name),module:{exports:{}},process:{pid:42}};
    vm.runInNewContext(fs.readFileSync('desktop/native-player-ipc.js','utf8'),context);
    context.module.exports.wireNativePlayer({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler(){}},window,catalogueView:{setVisible:value=>views.push(value)},executable:'player.exe',origin:'https://norva.tv',diagnostic:()=>{throw Error('disk full');}});
    const event={sender:webContents,senderFrame:webContents.mainFrame};
    await handlers.get('norva:native:open')(event,{host:'untrusted'});
    assert.equal(controller.options.host.handle,'1234');assert.equal(controller.options.host.processId,42);
    assert.deepEqual(views,[false]);
    assert.deepEqual(children,['remove']);
    controller.emit('fullscreen',true);assert.equal(full.at(-1),true);assert.equal(controller.fullscreen,true);
    controller.emit('event',{type:'closed'});assert.deepEqual(views,[false,true]);assert.equal(full.at(-1),false);
    assert.deepEqual(children,['remove','add']);
    // Disk-full diagnostics must not interfere with the next ordinary session drain.
    assert.doesNotThrow(()=>controller.emit('diagnostic',{reason:'viewer_closed'}));
    controller.open=async()=>{throw Error('closed barrier');};
    await assert.rejects(handlers.get('norva:native:open')(event,{}));assert.deepEqual(views,[false,true]);
});
