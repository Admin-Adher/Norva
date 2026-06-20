const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const net = require('net');
const path = require('path');

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

function createWindow(url, transcoderUrl) {
    const window = new BrowserWindow({
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
            preload: path.join(__dirname, 'preload.js'),
            // Tells the page where the in-app transcoder lives (residential IP),
            // so cloud-mode playback transcodes locally instead of via the
            // datacenter gateway the provider blocks.
            additionalArguments: transcoderUrl ? [`--norva-transcoder=${transcoderUrl}`] : []
        }
    });

    window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (targetUrl.startsWith(url)) {
            return { action: 'allow' };
        }

        shell.openExternal(targetUrl);
        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, targetUrl) => {
        if (targetUrl.startsWith(url)) {
            return;
        }

        event.preventDefault();
        shell.openExternal(targetUrl);
    });

    window.loadURL(url);
}

async function startDesktopApp() {
    app.setName(APP_NAME);

    const userData = app.getPath('userData');
    const port = await findFreePort();
    const serverUrl = `http://127.0.0.1:${port}`;

    // The window can load the bundled local UI (default, offline-capable) or the
    // cloud app for full cloud sync. Either way the in-app server runs as the
    // residential transcoder. Override with NORVA_DESKTOP_URL, e.g.
    // https://norva.tv/app.html for the pure cloud experience.
    const appUrl = process.env.NORVA_DESKTOP_URL || serverUrl;

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
    app.whenReady().then(startDesktopApp).catch((error) => {
        console.error(error);
        app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
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
