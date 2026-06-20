// Norva desktop preload.
//
// Exposes the in-app local transcoder base URL to the loaded page so playback
// is transcoded on THIS machine (residential IP) while catalog/resume sync
// through the cloud — the provider never sees a datacenter IP. Runs in a
// sandboxed, context-isolated preload, so only contextBridge is used.
//
// The transcoder URL is passed by electron-main via webPreferences
// additionalArguments (['--norva-transcoder=http://127.0.0.1:<port>']).

const { contextBridge } = require('electron');

function transcoderFromArgs() {
    const prefix = '--norva-transcoder=';
    const args = Array.isArray(process.argv) ? process.argv : [];
    const match = args.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : '';
}

try {
    const transcoder = transcoderFromArgs();
    if (transcoder) {
        contextBridge.exposeInMainWorld('NorvaDesktop', { transcoder });
    }
} catch (err) {
    // Never let preload failure block the app; playback just falls back to the
    // normal cloud path if the bridge isn't exposed.
    console.error('[Norva preload] failed to expose transcoder:', err && err.message);
}
