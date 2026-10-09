// Norva desktop preload.
//
// Exposes the in-app local transcoder base URL to the loaded page so playback
// is transcoded on THIS machine (residential IP) while catalog/resume sync
// through the cloud — the provider never sees a datacenter IP. Runs in a
// sandboxed, context-isolated preload, so only contextBridge is used.
//
// The transcoder URL is passed by electron-main via webPreferences
// additionalArguments (['--norva-transcoder=http://127.0.0.1:<port>']).

const { contextBridge, ipcRenderer } = require('electron');

function transcoderFromArgs() {
    const prefix = '--norva-transcoder=';
    const args = Array.isArray(process.argv) ? process.argv : [];
    const match = args.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : '';
}

try {
    const transcoder = transcoderFromArgs();
    const nativeOrigin = process.argv.find(arg => arg.startsWith('--norva-native-origin='))?.slice('--norva-native-origin='.length);
    const native = process.argv.includes('--norva-native-player=1') && location.origin === nativeOrigin;
    if (transcoder) {
        const invoke = (method, value) => ipcRenderer.invoke(`norva:native:${method}`,value);
        contextBridge.exposeInMainWorld('NorvaDesktop', { transcoder, ...(native ? { nativePlayer: {
            protocol:1,
            supportsPlayback: (type, container) => ['movie','series','episode'].includes(type)
                && ['mkv','mp4','m4v','avi','mov','mpeg','mpg','ts','m2ts','webm'].includes(String(container || '').toLowerCase()),
            privateMediaCacheProtocol: () => 0,
            playVideoJson: value => { void invoke('open', value).catch(() => window.dispatchEvent(new CustomEvent('norva:native-launch-failed'))); },
            stop: () => invoke('stop'),
            authorize: id => invoke('authorize',id),
            ackPlaybackSessionClosed: id => invoke('ack',id),
            pendingPlaybackCloses: () => invoke('pending-closes'),
            onEvent: callback => {
                const listener = (_event,value) => callback(value);
                ipcRenderer.on('norva:native:event',listener);
                return () => ipcRenderer.removeListener('norva:native:event',listener);
            }
        } } : {}) });
    }
} catch (err) {
    // Never let preload failure block the app; playback just falls back to the
    // normal cloud path if the bridge isn't exposed.
    console.error('[Norva preload] failed to expose transcoder:', err && err.message);
}
