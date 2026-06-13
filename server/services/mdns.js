let bonjour = null;
let published = null;

function start(port) {
    try {
        const Bonjour = require('bonjour-service');
        bonjour = new Bonjour.Bonjour();
        published = bonjour.publish({
            name: 'Norva Hub',
            type: 'norva',
            protocol: 'tcp',
            port: port
        });
        console.log('[mDNS] Hub announced on local network as "Norva Hub"');
    } catch (e) {
        console.warn('[mDNS] mDNS unavailable (optional):', e.message);
    }
}

function stop() {
    if (published) { try { published.stop(); } catch (e) {} }
    if (bonjour) { try { bonjour.destroy(); } catch (e) {} }
}

module.exports = { start, stop };
