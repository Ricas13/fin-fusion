'use strict';

const core = require('./reseller-monthly-portal-core');

function pruneRoutes(router, paths) {
    if (!router?.stack) return router;
    router.stack = router.stack.filter(layer => {
        if (layer.route && paths.has(String(layer.route.path))) return false;
        if (layer.handle?.stack) pruneRoutes(layer.handle, paths);
        return true;
    });
    return router;
}

function createResellerMonthlyPortalRouter() {
    const router = core.createResellerMonthlyPortalRouter();
    // These paths now have dedicated canonical owners. Removing them from the
    // old monthly portal stack avoids shadowing/duplicate Express routes while
    // preserving the rest of the battle-tested portal implementation.
    pruneRoutes(router, new Set([
        '/reseller/billing/tier',
        '/reseller/sales'
    ]));
    return router;
}

module.exports = { ...core, createResellerMonthlyPortalRouter, pruneRoutes };
