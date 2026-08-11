/** Mount the platform navigation projections before the application boots. */
(function bootstrapNavigation(root) {
    'use strict';

    const factory = root.NorvaNavigationAdapters?.createNavigationController;
    if (typeof factory !== 'function') {
        throw new Error('Norva navigation adapters are unavailable');
    }

    root.NorvaNavigation = factory({
        document: root.document,
        userAgent: root.navigator?.userAgent || '',
        search: root.location?.search || '',
    }).mount({ currentPage: 'home' });
}(window));
