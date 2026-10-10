'use strict';
const CLOUD_HOME = 'https://norva.tv/app#home';
const LANDING_PATHS = new Set(['/', '/index.html']);

function isSameAppOrigin(target, application) {
    try {
        const destination = new URL(target), origin = new URL(application);
        return ['http:', 'https:'].includes(destination.protocol) && destination.origin === origin.origin;
    } catch { return false; }
}

// A consumer desktop installation signs in to Norva Cloud. The bundled server
// remains a transport service; its first-admin setup is for explicit hub use.
function desktopApplicationUrl(override) {
    try {
        const url = new URL(override);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return CLOUD_HOME;
        return desktopNavigationTarget(url.href, url.href) || url.href;
    } catch { return CLOUD_HOME; }
}

function desktopNavigationTarget(target, application) {
    if (!isSameAppOrigin(target, application)) return null;
    const url = new URL(target);
    // Explicit self-hosted deployments retain their separate hub authentication.
    if (!/^(?:www\.)?norva\.tv$/i.test(url.hostname) || url.protocol !== 'https:') return null;
    if (LANDING_PATHS.has(url.pathname) || url.pathname === '/login.html') {
        return new URL('/account.html?returnTo=%2Fapp%23home', url.origin).href;
    }
    if (url.pathname !== '/account.html') return null;
    const requested = url.searchParams.get('returnTo');
    let valid = false;
    try {
        const returnUrl = new URL(requested, url.origin);
        valid = typeof requested === 'string' && requested.startsWith('/') && !requested.startsWith('//')
            && !requested.includes('\\') && returnUrl.origin === url.origin
            && !LANDING_PATHS.has(returnUrl.pathname) && returnUrl.pathname !== '/login.html'
            && returnUrl.pathname !== '/account.html';
    } catch { }
    if (valid) return null;
    // Preserve recovery/OTP/OAuth parameters and fragments. Only the post-login
    // destination changes; no authentication data is read or copied by the host.
    url.searchParams.set('returnTo', '/app#home');
    return url.href === target ? null : url.href;
}

function wireDesktopNavigation(webContents, { application, isAuthNavigation, openExternal }) {
    const redirect = target => {
        queueMicrotask(() => {
            if (!webContents.isDestroyed()) void webContents.loadURL(target).catch(() => {});
        });
    };
    const navigate = (event, target) => {
        const replacement = desktopNavigationTarget(target, application);
        if (replacement) { event.preventDefault(); redirect(replacement); return; }
        if (isSameAppOrigin(target, application) || isAuthNavigation(target)) return;
        event.preventDefault();
        openExternal(target);
    };
    webContents.on('will-navigate', navigate);
    webContents.on('will-redirect', (event, target, _inPlace, isMainFrame) => {
        if (event.isMainFrame === false || isMainFrame === false) return;
        navigate(event, target);
    });
    webContents.setWindowOpenHandler(({ url }) => {
        const replacement = desktopNavigationTarget(url, application);
        if (replacement) { redirect(replacement); return { action: 'deny' }; }
        if (isSameAppOrigin(url, application) || isAuthNavigation(url)) return { action: 'allow' };
        openExternal(url);
        return { action: 'deny' };
    });
}

module.exports = { isSameAppOrigin, desktopApplicationUrl, desktopNavigationTarget, wireDesktopNavigation };
