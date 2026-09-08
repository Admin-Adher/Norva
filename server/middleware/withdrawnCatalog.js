module.exports = function withdrawnCatalog(req, res, next) {
    if (!/^\/catalog\/(?:credits(?:\.html)?|sources(?:\.json)?)\/?$/i.test(req.path)) {
        return next();
    }
    res.status(410).set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-Content-Type-Options': 'nosniff'
    }).send('Page unavailable.');
};
