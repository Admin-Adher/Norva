'use strict';

// Admission telemetry, not a new inference/model lane. The distributed SQL
// claims enforce the hard ceiling; provider leases and viewer preemption remain
// authoritative. Unknown/stale cgroup telemetry fails closed for background work.
function decideLanguageBackgroundCapacity(sample, activity, now = Date.now()) {
    const result = (maxWorkers, reason) => ({ protocol: 1, maxWorkers, reason, observedAt: new Date(now).toISOString() });
    if (!sample || !Number.isFinite(sample.at) || now - sample.at > 30_000 || sample.at > now
        || ![sample.cpuRatio, sample.memoryRatio, sample.hostLoadRatio].every(Number.isFinite)) {
        return result(0, 'capacity-unavailable');
    }
    if (activity.viewer || activity.starting) return result(0, 'viewer-priority');
    if (activity.foregroundInference || activity.benchmark) return result(0, 'foreground-work');
    if (sample.cpuRatio >= 0.8 || sample.memoryRatio >= 0.85 || sample.hostLoadRatio >= 0.9) {
        return result(0, 'resource-pressure');
    }
    if (activity.backgroundProcesses >= 2 || activity.brokers >= 2) return result(0, 'background-occupied');
    return result(sample.cpuRatio >= 0.6 || sample.memoryRatio >= 0.75 || sample.hostLoadRatio >= 0.7 ? 1 : 2,
        'capacity-available');
}

// Metadata has a separate short network lane. A running Whisper process is not
// by itself a provider connection. Resource pressure and foreground work still
// stop admission, and the Gateway's synchronous reservation enforces the shared
// two-network-operation ceiling after this advisory snapshot becomes stale.
function decideLanguageMetadataCapacity(sample, activity, network, enabled, now = Date.now()) {
    const result = (maxWorkers, reason) => ({ protocol: 1, maxWorkers, reason, observedAt: new Date(now).toISOString() });
    if (enabled !== true) return result(0, 'metadata-lane-disabled');
    const base = decideLanguageBackgroundCapacity(sample, { ...activity, backgroundProcesses: 0, brokers: 0 }, now);
    if (!base.maxWorkers) return result(0, base.reason);
    if (!network || !Number.isInteger(network.maximum) || network.maximum < 1 || network.maximum > 2
        || !Number.isInteger(network.active) || network.active < 0 || network.active > network.maximum) {
        return result(0, 'capacity-unavailable');
    }
    if (network.active >= network.maximum) return result(0, 'network-occupied');
    // This is an absolute lane ceiling, not a count of additional SQL claims.
    // SQL counts its own live metadata leases; the local reservation counts all
    // strict capture + metadata network work, including Selection.
    return result(Math.min(base.maxWorkers, network.maximum), 'capacity-available');
}

function createLanguageResourceSampler({ readFile, os, now = Date.now, interval = setInterval }) {
    let previous = null;
    let latest = null;
    let reading = false;
    async function sample() {
        if (reading) return;
        reading = true;
        try {
            const [stat, max, used, memoryMax] = await Promise.all([
                readFile('/sys/fs/cgroup/cpu.stat', 'utf8'), readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
                readFile('/sys/fs/cgroup/memory.current', 'utf8'), readFile('/sys/fs/cgroup/memory.max', 'utf8'),
            ]);
            const at = now();
            const usage = Number(stat.match(/^usage_usec\s+(\d+)$/m)?.[1]);
            const [quota, period] = max.trim().split(/\s+/);
            const hostCpus = os.cpus().length;
            const cpus = quota === 'max' ? hostCpus : Math.min(hostCpus, Number(quota) / Number(period));
            const memoryLimit = memoryMax.trim() === 'max' ? os.totalmem() : Number(memoryMax);
            if (previous && at > previous.at && at - previous.at <= 30_000 && usage >= previous.usage
                && cpus > 0 && memoryLimit > 0) {
                latest = { at, cpuRatio: (usage - previous.usage) / ((at - previous.at) * 1000 * cpus),
                    memoryRatio: Number(used) / memoryLimit, hostLoadRatio: os.loadavg()[0] / hostCpus };
            } else latest = null;
            previous = { at, usage };
        } catch (_) { latest = null; previous = null; }
        finally { reading = false; }
    }
    const timer = interval(() => { void sample(); }, 5000);
    timer.unref?.();
    void sample();
    return { snapshot: () => latest, sample };
}

module.exports = { decideLanguageBackgroundCapacity, decideLanguageMetadataCapacity, createLanguageResourceSampler };
