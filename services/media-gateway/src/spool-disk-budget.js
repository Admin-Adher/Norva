'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const quota = code => Object.assign(new Error(code), { code });
const rootQueues = new Map();

async function reserveSpoolDisk(options) {
    // Serialize local contenders before taking the cross-process lock. A burst
    // of 100 viewers must not create 100 polling loops on the same filesystem.
    const key = path.resolve(options.root);
    const pending = (rootQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => reserveSpoolDiskLocked(options));
    rootQueues.set(key, pending);
    try { return await pending; }
    finally { if (rootQueues.get(key) === pending) rootQueues.delete(key); }
}

// All gateway replicas on one disk must mount this same directory. Reservations
// survive process failure: uncertainty disables optional caching, never permits
// overcommit. No provider identifier, URL or credential enters the ledger.
async function reserveSpoolDiskLocked({ root, name, bytes, maxBytes, minFreeBytes, statfs = fs.statfs }) {
    if (![bytes, maxBytes, minFreeBytes].every(Number.isSafeInteger)
        || bytes <= 0 || maxBytes <= 0 || minFreeBytes < 0
        || !/^spool-[A-Za-z0-9_.-]+$/.test(name)) throw quota('SPOOL_BUDGET_CONFIG');
    if (bytes > maxBytes) throw quota('SPOOL_GLOBAL_QUOTA');
    const directory = path.join(root, '.reservations');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw quota('SPOOL_UNSAFE_BUDGET');
    const lock = path.join(directory, '.lock');
    const deadline = Date.now() + 15000;
    while (true) {
        try { await fs.mkdir(lock, { mode: 0o700 }); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) throw quota('SPOOL_BUDGET_BUSY');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    try {
        let reserved = 0, materialized = 0, legacy = 0;
        const names = new Set();
        for (const entry of await fs.readdir(directory)) {
            if (!/^[a-f0-9]{32}\.json$/.test(entry)) continue;
            const raw = await fs.readFile(path.join(directory, entry), 'utf8').catch(error => {
                // Cleanup removes the data before releasing its reservation.
                // A concurrent release after readdir is available capacity,
                // not a corrupt ledger or a reason to reject another viewer.
                if (error.code === 'ENOENT') return null; throw error;
            });
            if (raw === null) continue;
            const item = JSON.parse(raw);
            if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0
                || !/^spool-[A-Za-z0-9_.-]+$/.test(item.name) || names.has(item.name)) throw quota('SPOOL_BUDGET_CORRUPT');
            names.add(item.name);
            reserved += item.bytes;
        }
        // Include legacy files which predate the reservation ledger. For
        // reserved files this count offsets bytes already spent on disk.
        for (const name of await fs.readdir(root)) {
            if (!/^spool-[A-Za-z0-9_.-]+\.(part|bin)$/.test(name)) continue;
            const info = await fs.lstat(path.join(root, name)).catch(error => {
                if (error.code === 'ENOENT') return null; throw error;
            });
            if (!info) continue;
            if (!info.isFile() || info.isSymbolicLink()) throw quota('SPOOL_UNSAFE_BUDGET');
            if (names.has(name.replace(/\.(part|bin)$/, ''))) materialized += info.size;
            else legacy += info.size;
        }
        if (Math.max(reserved, materialized) + legacy + bytes > maxBytes) throw quota('SPOOL_GLOBAL_QUOTA');
        const disk = await statfs(root);
        const free = disk.availableBytes ?? Number(disk.bavail) * Number(disk.bsize);
        if (!Number.isSafeInteger(free) || free - Math.max(0, reserved - materialized) - bytes < minFreeBytes)
            throw quota('SPOOL_DISK_RESERVE');
        const file = path.join(directory, `${crypto.randomBytes(16).toString('hex')}.json`);
        await fs.writeFile(file, JSON.stringify({ name, bytes, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        let released = false;
        return { async release() {
            if (released) return;
            await fs.rm(file, { force: true }); released = true;
        }, async checkFreeSpace() {
            const current = await statfs(root);
            const available = current.availableBytes ?? Number(current.bavail) * Number(current.bsize);
            if (!Number.isSafeInteger(available) || available < minFreeBytes) throw quota('SPOOL_DISK_RESERVE');
        } };
    } finally { await fs.rmdir(lock); }
}

// File operations must not wait behind the gateway's media pumps and process
// callbacks. One worker keeps the same durable, cross-process ledger protocol
// off that busy event loop. It owns leases until their data has been removed.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const budgetWorker = !isMainThread && workerData?.norvaDiskBudget === true;
let worker, workerFailure, nextRequest = 0;
const requests = new Map();

function workerCall(operation, payload) {
    if (workerFailure) return Promise.reject(workerFailure);
    if (!worker) {
        worker = new Worker(__filename, { workerData: { norvaDiskBudget: true }, execArgv: [] });
        const failed = () => {
            // Reservations survive an uncertain worker result. Never restart
            // with an empty in-memory budget or silently release unknown data.
            workerFailure = quota('SPOOL_BUDGET_WORKER_UNAVAILABLE');
            for (const pending of requests.values()) pending.reject(workerFailure);
            requests.clear(); worker.unref();
        };
        worker.on('error', failed);
        worker.on('exit', failed);
        worker.on('message', message => {
            const pending = requests.get(message.id);
            if (!pending) return;
            requests.delete(message.id);
            if (!requests.size) worker.unref();
            if (message.error) pending.reject(quota(message.error));
            else pending.resolve(message.value);
        });
    }
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject }); worker.ref();
        try { worker.postMessage({ id, operation, ...payload }); }
        catch (error) {
            requests.delete(id); if (!requests.size) worker.unref(); reject(error);
        }
    });
}

async function reserveInWorker(options) {
    // The injectable filesystem probe is used only by deterministic policy
    // tests; it cannot be transferred to a worker. Production uses real statfs.
    if (options.statfs) return reserveSpoolDisk(options);
    const { root, name, bytes, maxBytes, minFreeBytes } = options;
    const leaseId = await workerCall('reserve', { options: { root, name, bytes, maxBytes, minFreeBytes } });
    let releasePromise;
    return {
        release() {
            if (!releasePromise) releasePromise = workerCall('release', { leaseId }).catch(error => {
                releasePromise = null; throw error;
            });
            return releasePromise;
        },
        checkFreeSpace() { return workerCall('check', { leaseId }); },
    };
}

if (budgetWorker) {
    const leases = new Map();
    parentPort.on('message', async ({ id, operation, options, leaseId }) => {
        try {
            let value;
            if (operation === 'reserve') {
                const lease = await reserveSpoolDisk(options);
                value = crypto.randomBytes(16).toString('hex'); leases.set(value, lease);
            } else {
                const lease = leases.get(leaseId);
                if (!lease) throw quota('SPOOL_BUDGET_LEASE_MISSING');
                if (operation === 'release') { await lease.release(); leases.delete(leaseId); }
                else if (operation === 'check') await lease.checkFreeSpace();
                else throw quota('SPOOL_BUDGET_CONFIG');
            }
            parentPort.postMessage({ id, value });
        } catch (error) {
            parentPort.postMessage({ id, error: error.code || 'SPOOL_BUDGET_IO' });
        }
    });
}

module.exports = { reserveSpoolDisk: budgetWorker ? reserveSpoolDisk : reserveInWorker };
