'use strict';
const { MaintenanceFence } = require('./maintenance-fence');
function registerMaintenance({ app, enabled, authenticate, snapshot, persisted, closeAdmissions, wake, viewerRequest = () => false }) {
    if (!enabled) return null;
    const fence = new MaintenanceFence({ wake });
    const timer = setInterval(() => fence.expire(), 1000); timer.unref();
    const paths = new Set(['/maintenance/prepare', '/maintenance/cancel', '/maintenance/commit']);
    app.use((req, res, next) => {
        if (req.path === '/health' || paths.has(req.path)) return next();
        if (fence.state && fence.state.phase !== 'committed' && viewerRequest(req)) fence.cancel(fence.state.token);
        const release = fence.enter();
        if (!release) { res.setHeader('Retry-After', '2'); return res.status(503).json({ error: 'Temporarily unavailable' }); }
        res.once('finish', release); res.once('close', release);
        next();
    });
    for (const action of ['prepare', 'cancel', 'commit']) {
        app.post(`/maintenance/${action}`, authenticate, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (action === 'prepare' && !req.body?.token && snapshot().viewerSessions !== 0)
                    return res.status(409).json({ error: 'Playback is active' });
                const token = action === 'prepare' && !req.body?.token ? fence.begin() : req.body?.token;
                if (action === 'cancel') { fence.cancel(token); return res.json({ resumed: true }); }
                const ready = await fence.verify(token, { snapshot, persisted });
                if (action === 'prepare') return res.status(ready ? 200 : 202).json({ token, ready });
                if (!ready) return res.status(409).json({ error: 'Maintenance not ready' });
                fence.commit(token, snapshot, closeAdmissions);
                return res.json({ committed: true });
            } catch (_) { return res.status(409).json({ error: 'Maintenance lease unavailable' }); }
        });
    }
    return fence;
}
module.exports = { registerMaintenance };
