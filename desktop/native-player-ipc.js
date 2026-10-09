'use strict';
const { NativePlayerController } = require('./native-player-controller');

function trustedSender(event, window, origin) {
    try { return !window.isDestroyed() && event.sender === window.webContents
        && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin; }
    catch { return false; }
}
function wireNativePlayer({ ipcMain, window, executable, origin }) {
    const controller = new NativePlayerController(executable);
    const channels = ['open','stop','authorize','ack','pending-closes'];
    const handle = (name, action) => ipcMain.handle(`norva:native:${name}`, async (event, value) => {
        if (!trustedSender(event,window,origin)) throw Error('NATIVE_ORIGIN_REJECTED');
        return action(value);
    });
    handle('open', async value => {
        const result = await controller.open(value); window.setEnabled(false); return result;
    });
    handle('stop', () => controller.stop());
    handle('authorize', id => controller.authorize(id));
    handle('ack', id => controller.acknowledge(id));
    handle('pending-closes', () => [...controller.unacknowledged]);
    controller.on('event', event => {
        if (window.isDestroyed()) return;
        if (event.type === 'closed') { window.setEnabled(true); window.focus(); }
        try {
            if (new URL(window.webContents.getURL()).origin === origin) window.webContents.send('norva:native:event',event);
        } catch { }
    });
    window.webContents.on('did-start-navigation', (_event,_url,isInPlace,isMainFrame) => {
        if (isMainFrame && !isInPlace) void controller.stop();
    });
    window.webContents.on('render-process-gone', () => { void controller.stop(); });
    window.on('closed', () => { void controller.stop(); for (const name of channels) ipcMain.removeHandler(`norva:native:${name}`); });
    return controller;
}
module.exports = { wireNativePlayer, trustedSender };
