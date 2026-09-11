'use strict';

// Synchronous reservation closes the gap between a health snapshot and opening
// a socket. It supplements (never replaces) distributed account leases and
// viewer preemption. Slots have no timer-based expiry: only confirmed drain can
// release one. A timed-out/uncertain operation must fail closed.
function createEnrichmentNetworkAdmission({ maximum = 2, selectionPolicy = null, adaptiveHosts = false, now = Date.now } = {}) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2) {
        throw new Error('Invalid enrichment network ceiling');
    }
    const leases = new Set();
    const hosts = new Map();
    const configured = new Map();
    const hostState = host => {
        if (!hosts.has(host)) hosts.set(host, { limit:1, successes:0, cooldownUntil:0, metrics:{}, epoch:0, touchedAt:now() });
        return hosts.get(host);
    };
    // Operator-configured hosts are bounded by the policy schema. In the
    // optional general-host mode, retain at most 128 hosts; never evict a live
    // permit/cooldown merely to admit an unknown import.
    const approved = candidate => selectionPolicy?.describe(candidate) || null;
    const registerTargets = (targets, required) => {
        for (const target of targets) {
            const policyMaximum = selectionPolicy?.ceilingForHost?.(target.host);
            if (!required && !policyMaximum && !configured.has(target.host)) continue;
            if (!hosts.has(target.host) && hosts.size >= 128) {
                const removable = [...hosts].filter(([key,s]) => s.cooldownUntil <= now()
                    && !targets.some(t=>t.host===key)
                    && ![...leases].some(l=>l.targets.some(t=>t.host===key))).sort((a,b)=>a[1].touchedAt-b[1].touchedAt)[0];
                if (!removable) return false;
                hosts.delete(removable[0]);configured.delete(removable[0]);
            }
            configured.set(target.host,Math.min(configured.get(target.host) || 2,target.maximum,policyMaximum || 2));
            hostState(target.host).touchedAt=now();
        }
        return true;
    };
    return {
        snapshot: () => ({ maximum:[...leases].some(l=>l.opaqueTarget) ? 1 : maximum, active: leases.size }),
        policySnapshot: () => ({ protocol:1, configuredHosts:hosts.size,
            limitedHosts:[...hosts.values()].filter(s=>s.limit===1).length,
            coolingHosts:[...hosts.values()].filter(s=>s.cooldownUntil>now()).length }),
        acquire({ accountKey, hostKey, selection = null, opaqueTarget = false }) {
            if (typeof accountKey !== 'string' || !accountKey || typeof hostKey !== 'string' || !hostKey) return null;
            const grant = approved(selection);
            // FFprobe still follows some container redirects internally. Until
            // those targets can be reserved, serialize opaque acquisition with
            // all other I/O instead of assuming a configured final-host cap.
            if ([...leases].some(l=>l.opaqueTarget) || (opaqueTarget && leases.size > 0)) return null;
            if (grant && grant.sourceHost !== hostKey) return null;
            const targets = grant ? [...grant.hosts] : [{ host:hostKey, maximum }];
            if (!registerTargets(targets,grant || adaptiveHosts)) return null;
            if (leases.size >= maximum || [...leases].some(lease => lease.accountKey === accountKey && (!grant || !lease.grant))) return null;
            for (const target of targets) {
                if (!configured.has(target.host)) continue;
                const state = hostState(target.host);
                const active = [...leases].filter(l=>l.targets.some(t=>t.host===target.host)).length;
                if (state.cooldownUntil > now() || active >= Math.min(state.limit,configured.get(target.host))) return null;
            }
            const lease = { accountKey, hostKey, targets, grant, opaqueTarget, startedAt:now(), observed:false,
                states:new Map(targets.filter(t=>configured.has(t.host)).map(t=>[t.host,hostState(t.host)])),
                epochs:new Map(targets.filter(t=>configured.has(t.host)).map(t=>[t.host,hostState(t.host).epoch])) };
            leases.add(lease);
            let released = false;
            return {
                // The broker calls this synchronously BEFORE every redirect
                // request. Keep all earlier hosts reserved through positive
                // drain; two aliases cannot quietly exceed one CDN ceiling.
                reserveTarget(host) {
                    if (released || typeof host !== 'string' || !host) return false;
                    if (targets.some(t=>t.host===host)) return true;
                    if (grant || targets.length >= 8) return false;
                    const target = {host,maximum};
                    if (!registerTargets([target],adaptiveHosts)) return false;
                    if (configured.has(host)) {
                        const state = hostState(host);
                        const active = [...leases].filter(l=>l!==lease && l.targets.some(t=>t.host===host)).length;
                        if (state.cooldownUntil > now() || active >= Math.min(state.limit,configured.get(host))) return false;
                        lease.states.set(host,state);lease.epochs.set(host,state.epoch);
                    }
                    targets.push(target);
                    return true;
                },
                // Record exactly once after confirmed drain. Delayed successes
                // from before a refusal cannot undo its cooldown or raise a cap.
                observe({ ok, durationMs, neutral = false, retryAfterSeconds = 0, drained = false, lane = 'capture' } = {}) {
                    if (lease.observed || !released || drained !== true) return false;
                    lease.observed = true;
                    if ((!grant && !adaptiveHosts) || neutral) return true;
                    for (const target of targets) {
                        const state = hosts.get(target.host);
                        if (!state || state !== lease.states.get(target.host)) continue;
                        state.touchedAt=now();
                        if (ok !== true) {
                            state.limit = 1; state.successes = 0; state.epoch++;
                            // An unusually long Retry-After needs an operator,
                            // not a shorter locally chosen retry interval.
                            const quiet = retryAfterSeconds > 86400 ? Infinity
                                : Math.max(60_000,Number.isFinite(retryAfterSeconds)?retryAfterSeconds*1000:0);
                            state.cooldownUntil = Math.max(state.cooldownUntil,now()+quiet);
                            continue;
                        }
                        if (lease.epochs.get(target.host) !== state.epoch || state.cooldownUntil > now()
                            || !Number.isFinite(durationMs) || durationMs <= 0) continue;
                        // A full audio window is naturally slower than a short
                        // header probe. Never compare those unlike workloads.
                        const kind = lane === 'metadata' ? 'metadata' : 'capture';
                        const metric = state.metrics[kind] || { ewma:durationMs,baseline:durationMs };
                        metric.ewma=.2*durationMs+.8*metric.ewma;
                        metric.baseline=Math.min(metric.baseline,metric.ewma);
                        state.metrics[kind]=metric;
                        if (metric.ewma > Math.max(1000,metric.baseline*1.75)) {
                            state.limit=1;state.successes=0;state.epoch++;state.cooldownUntil=now()+30_000;
                        } else if (++state.successes >= 8) {
                            state.limit=Math.min(2,configured.get(target.host));state.successes=0;
                        }
                    }
                    return true;
                },
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
