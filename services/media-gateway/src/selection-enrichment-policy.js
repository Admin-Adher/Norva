'use strict';

const FEEDS = new Set(['herbert-tested-vod', 'klysmgt-tested-vod', 'sandro-tested-vod']);
const fail = () => Object.assign(new Error('SELECTION_ENRICHMENT_POLICY_INVALID'), { code:'SELECTION_ENRICHMENT_POLICY_INVALID' });
const refused = () => Object.assign(new Error('SELECTION_ENRICHMENT_TARGET_NOT_APPROVED'), { code:'SELECTION_ENRICHMENT_TARGET_NOT_APPROVED' });

// An operator-owned, exact feed + host allowlist. No catalogue labels, imported
// metadata, wildcard, redirect discovery or claimed provider connection limit
// can grant an exception. Missing configuration leaves EVERY account at one.
function createSelectionEnrichmentPolicy(raw) {
    const grants = new Map(); const capabilities = new WeakSet();
    if (raw !== undefined && raw !== null && raw !== '') {
        let config;
        try { config = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw fail(); }
        if (config?.version !== 1 || !Array.isArray(config.feeds) || config.feeds.length > FEEDS.size) throw fail();
        for (const feed of config.feeds) {
            if (!FEEDS.has(feed?.feedId) || grants.has(feed.feedId) || !Array.isArray(feed.hosts)
                || !feed.hosts.length || feed.hosts.length > 8) throw fail();
            const hosts = new Map();
            for (const entry of feed.hosts) {
                const host = entry?.host;
                if (typeof host !== 'string' || host.length > 253 || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)
                    || host.startsWith('.') || host.endsWith('.') || host.includes('..')
                    || !Number.isInteger(entry.maxParallel) || entry.maxParallel < 1 || entry.maxParallel > 2 || hosts.has(host)) throw fail();
                let url; try { url = new URL(`https://${host}`); } catch { throw fail(); }
                if (url.host !== host || !url.hostname.includes('.') || url.username || url.password) throw fail();
                hosts.set(host, entry.maxParallel);
            }
            grants.set(feed.feedId, hosts);
        }
    }
    const ceilings = new Map();
    for (const hosts of grants.values()) for (const [host,cap] of hosts) ceilings.set(host,Math.min(ceilings.get(host) || 2,cap));
    const describe = candidate => candidate && capabilities.has(candidate) ? candidate : null;
    return Object.freeze({
        configured: grants.size > 0,
        // Also constrain ordinary jobs that resolve to an approved Selection
        // host; a different source label is not an independent host budget.
        ceilingForHost: host => ceilings.get(host) || null,
        // Only invoke with claims already authenticated by the existing HMAC
        // verifier. The Selection worker obtains feedId from its immutable file
        // manifest, never from a client-supplied source name or URL metadata.
        resolve(claims) {
            if (claims?.selectionEnrichmentProtocol !== 1 || typeof claims.selectionFeedId !== 'string') return null;
            const hosts = grants.get(claims.selectionFeedId); if (!hosts) return null;
            let source; try { source = new URL(claims.url); } catch { return null; }
            if (!['http:','https:'].includes(source.protocol) || source.username || source.password || !hosts.has(source.host)) return null;
            // Pessimistically reserve every authorized redirect host at once.
            // Thus aliases/two feeds cannot oversubscribe one shared CDN host.
            const capability = Object.freeze({ feedId:claims.selectionFeedId, sourceHost:source.host,
                hosts:Object.freeze([...hosts].map(([host,maximum])=>Object.freeze({ host,maximum:Math.min(maximum,ceilings.get(host)) }))),
                assertTarget(target) {
                    let parsed; try { parsed = new URL(target); } catch { throw refused(); }
                    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password
                        || !hosts.has(parsed.host) || (source.protocol === 'https:' && parsed.protocol !== 'https:')) throw refused();
                } });
            capabilities.add(capability); return capability;
        },
        describe,
    });
}

module.exports = { createSelectionEnrichmentPolicy };
