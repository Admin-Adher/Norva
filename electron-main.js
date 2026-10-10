const { app, BrowserWindow, BaseWindow, WebContentsView, shell, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { desktopApplicationUrl, wireDesktopNavigation } = require('./desktop/navigation');

const APP_NAME = 'Norva';
const PORT_START = 3002;
const PORT_END = 3999;

function findFreePort(start = PORT_START, end = PORT_END) {
    return new Promise((resolve, reject) => {
        let port = start;

        const tryPort = () => {
            if (port > end) {
                reject(new Error(`No free port found between ${start} and ${end}`));
                return;
            }

            const server = net.createServer();
            server.unref();
            server.on('error', () => {
                port += 1;
                tryPort();
            });
            server.listen(port, '127.0.0.1', () => {
                const freePort = port;
                server.close(() => resolve(freePort));
            });
        };

        tryPort();
    });
}

function waitForServer(url, timeoutMs = 20000) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const check = () => {
            const request = http.get(url, (response) => {
                response.resume();
                resolve();
            });

            request.on('error', () => {
                if (Date.now() - startedAt > timeoutMs) {
                    reject(new Error(`Server did not start at ${url}`));
                    return;
                }
                setTimeout(check, 250);
            });

            request.setTimeout(2000, () => {
                request.destroy();
            });
        };

        check();
    });
}

// OAuth (Google/Apple sign-in via Supabase) is a full-page redirect chain:
// norva.tv → <project>.supabase.co/auth/v1/authorize → accounts.google.com →
// back to norva.tv/account.html#access_token=… . Those hops leave the app's own
// origin, so without this allow-list the navigation handlers below would bounce
// them to the system browser and the returning session would never reach the
// desktop window. Keep it to identity providers only — everything else still
// opens externally.
const AUTH_NAV_HOSTS = [
    'supabase.co',
    'supabase.in',
    'accounts.google.com',
    'accounts.youtube.com',
    'appleid.apple.com'
];

function isAuthNavigation(targetUrl) {
    try {
        const host = new URL(targetUrl).hostname;
        return AUTH_NAV_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    } catch (_) {
        return false;
    }
}

function createWindow(url, transcoderUrl) {
    const nativeExecutable = path.join(app.isPackaged ? process.resourcesPath : __dirname,
        'native-player', 'Norva.NativePlayer.exe');
    const nativeEnabled = process.platform === 'win32' && process.env.NORVA_DESKTOP_NATIVE_PLAYER !== '0'
        && fs.existsSync(nativeExecutable);
    const options = {
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        title: APP_NAME,
        backgroundColor: '#050505',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: !nativeEnabled,
            preload: path.join(__dirname, 'preload.js'),
            // Tells the page where the in-app transcoder lives (residential IP),
            // so cloud-mode playback transcodes locally instead of via the
            // datacenter gateway the provider blocks.
            additionalArguments: [
                ...(transcoderUrl ? [`--norva-transcoder=${transcoderUrl}`] : []),
                ...(nativeEnabled ? ['--norva-native-player=1',`--norva-native-origin=${new URL(url).origin}`] : [])
            ]
        }
    };
    let window, catalogueView;
    if (nativeEnabled) {
        const {webPreferences, ...frameOptions} = options;
        window = new BaseWindow(frameOptions);
        catalogueView = new WebContentsView({webPreferences});
        window.contentView.addChildView(catalogueView);
        const layout = () => { const [width,height] = window.getContentSize(); catalogueView.setBounds({x:0,y:0,width,height}); };
        layout(); window.on('resize',layout);
        // Preserve the existing exact-origin IPC/navigation contract.
        window.webContents = catalogueView.webContents;
        window.loadURL = url => window.webContents.loadURL(url);
        window.on('closed', () => { if (!window.webContents.isDestroyed()) window.webContents.close(); });
    } else window = new BrowserWindow(options);

    if (nativeEnabled) require('./desktop/native-player-ipc').wireNativePlayer({
        ipcMain, window, catalogueView, executable:nativeExecutable, origin:new URL(url).origin,
        diagnostic: value => {
            // Bounded technical timings only: no account/session IDs, URLs,
            // headers, native decoder stderr or media bytes in this receipt.
            try { fs.writeFileSync(path.join(app.getPath('userData'), 'native-playback-last.json'), JSON.stringify({at:new Date().toISOString(), ...value})); } catch { }
        }
    });

    wireDesktopNavigation(window.webContents, {
        application: url,
        isAuthNavigation,
        openExternal: target => shell.openExternal(target)
    });

    window.loadURL(url);
}

async function startDesktopApp() {
    app.setName(APP_NAME);

    const userData = app.getPath('userData');
    const port = await findFreePort();
    const serverUrl = `http://127.0.0.1:${port}`;

    // Norva Cloud is the consumer entry point. Starting at the bundled hub on a
    // clean installation instead exposed first-administrator registration.
    // A self-hosted hub remains an explicit NORVA_DESKTOP_URL override.
    const appUrl = desktopApplicationUrl(process.env.NORVA_DESKTOP_URL);

    // If we load a remote (cloud) origin, let the in-app server accept its
    // cross-origin playback calls so the page can use the local transcoder.
    try {
        const appOrigin = new URL(appUrl).origin;
        if (appOrigin !== serverUrl) {
            const origins = (process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [])
                .map((s) => s.trim())
                .filter(Boolean);
            if (!origins.includes(appOrigin)) origins.push(appOrigin);
            process.env.CORS_ORIGINS = origins.join(',');
        }
    } catch (_) { /* appUrl invalid -> fall back to local serverUrl below */ }

    process.env.NODE_ENV = 'production';
    process.env.PORT = String(port);
    process.env.NODECAST_DATA_DIR = path.join(userData, 'data');
    process.env.NODECAST_CACHE_DIR = path.join(userData, 'cache');
    process.env.NODECAST_TRANSCODE_CACHE_DIR = path.join(userData, 'transcode-cache');

    require('./server/index');

    await waitForServer(`${serverUrl}/login.html`);
    createWindow(appUrl, serverUrl);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        for (const window of BaseWindow.getAllWindows()) {
            if (window.isMinimized()) window.restore();
            window.focus();
        }
    });
    app.whenReady().then(startDesktopApp).catch((error) => {
        console.error(error);
        app.quit();
    });

    app.on('activate', () => {
        if (BaseWindow.getAllWindows().length === 0) {
            startDesktopApp().catch((error) => {
                console.error(error);
                app.quit();
            });
        }
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
