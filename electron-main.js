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

function createWindow(url) {
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
            sandbox: true
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

    process.env.NODE_ENV = 'production';
    process.env.PORT = String(port);
    process.env.NODECAST_DATA_DIR = path.join(userData, 'data');
    process.env.NODECAST_CACHE_DIR = path.join(userData, 'cache');
    process.env.NODECAST_TRANSCODE_CACHE_DIR = path.join(userData, 'transcode-cache');

    require('./server/index');

    await waitForServer(`${serverUrl}/login.html`);
    createWindow(serverUrl);
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
