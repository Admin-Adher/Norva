'use strict';
const { NativePlayerController } = require('./native-player-controller');

function trustedSender(event, window, origin) {
    try { return !window.isDestroyed() && event.sender === window.webContents
        && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin; }
    catch { return false; }
}
function wireNativePlayer({ ipcMain, window, catalogueView, executable, origin, diagnostic = () => {} }) {
    // Only the main process supplies the host HWND; renderer requests cannot
    // select another window or process. Windows x64 returns a little-endian HWND.
    const handle = window.getNativeWindowHandle();
    const host = { handle:handle.readBigUInt64LE().toString(16), processId:process.pid };
    const controller = new NativePlayerController(executable, {host});
    controller.on('diagnostic', data => { try { diagnostic(data); } catch { /* Diagnostics cannot prevent session drain. */ } });
    const channels = ['open','stop','authorize','ack','pending-closes'];
    const register = (name, action) => ipcMain.handle(`norva:native:${name}`, async (event, value) => {
        if (!trustedSender(event,window,origin)) throw Error('NATIVE_ORIGIN_REJECTED');
        return action(value);
    });
    register('open', async value => {
        const result = await controller.open(value);
        // Chromium's compositor can cover ordinary child controls even when
        // LibVLC's native swapchain remains visible. Keep the catalogue alive
        // for heartbeats/history, and hide its view during native playback.
        catalogueView.setVisible(false);
        window.contentView.removeChildView(catalogueView);
        return result;
    });
    register('stop', () => controller.stop());
    register('authorize', id => controller.authorize(id));
    register('ack', id => controller.acknowledge(id));
    register('pending-closes', () => [...controller.unacknowledged]);
    controller.on('fullscreen', enabled => {
        window.setFullScreen(enabled);
        controller.setFullscreen(enabled);
    });
    const syncFullscreen = () => controller.setFullscreen(window.isFullScreen());
    window.on('enter-full-screen', syncFullscreen);
    window.on('leave-full-screen', syncFullscreen);
    controller.on('event', event => {
        if (window.isDestroyed()) return;
        if (event.type === 'closed') { window.contentView.addChildView(catalogueView); catalogueView.setVisible(true); window.setFullScreen(false); window.focus(); }
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
