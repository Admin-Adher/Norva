'use strict';

// Synchronous reservation closes the gap between a health snapshot and opening
// a socket. It supplements (never replaces) distributed account leases and
// viewer preemption. Slots have no timer-based expiry: only confirmed drain can
// release one. A timed-out/uncertain operation must fail closed.
function createEnrichmentNetworkAdmission({ maximum = 2 } = {}) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2) {
        throw new Error('Invalid enrichment network ceiling');
    }
    const leases = new Set();
    return {
        snapshot: () => ({ maximum, active: leases.size }),
        acquire({ accountKey, hostKey }) {
            if (typeof accountKey !== 'string' || !accountKey || typeof hostKey !== 'string' || !hostKey) return null;
            if (leases.size >= maximum || [...leases].some(lease => lease.accountKey === accountKey)) return null;
            const lease = { accountKey, hostKey };
            leases.add(lease);
            let released = false;
            return {
                release({ providerDrained } = {}) {
                    if (providerDrained !== true) return false;
                    if (!released) leases.delete(lease);
                    released = true;
                    return true;
                },
            };
        },
    };
}

module.exports = { createEnrichmentNetworkAdmission };
