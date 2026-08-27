'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function explicitRoutes(source) {
    const routes = [];
    const pattern = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(source))) routes.push(`${match[1].toUpperCase()} ${match[2]}`);
    return routes.sort();
}

function main() {
    const platformRouter = read('src/platform/router.js');
    const routerCore = read('src/platform/router-core.js');
    const librarySelection = read('src/platform/customer-library-selection.js');
    const passwordSync = read('src/platform/customer-password-sync.js');
    const publicPages = read('src/platform/public-pages.js');
    const adminComposition = read('src/platform/admin-route-composition.js');
    const retiredLegacyPath = path.join(root, 'src/platform/router-runtime-legacy.js');

    assert(!platformRouter.includes('pruneRoutes'), 'platform router must not prune Express route stacks at runtime');
    assert(!/\.stack\s*=/.test(platformRouter), 'platform router must not mutate Express private .stack internals');
    assert(!platformRouter.includes('core.createRouter()'), 'production must not construct the obsolete router-core route set');
    assert(!platformRouter.includes('createRuntimeLegacyRouter'), 'production must not reconstruct the retired runtime legacy router');
    assert(!fs.existsSync(retiredLegacyPath), 'router-runtime-legacy.js must remain deleted once all production routes have canonical owners');
    assert(platformRouter.includes('createCustomerLibrarySelectionRouter()'), 'customer library selection must have a named canonical router owner');
    assert(!platformRouter.includes('onlyPathPrefix'), 'platform router must not hide child routers behind opaque path-prefix middleware');
    assert(!platformRouter.includes('createAdminNotificationPreferencesRouter'), 'global admin notification preferences must not have a second owner in the platform router');
    assert(adminComposition.includes('app.use(createAdminNotificationPreferencesRouter());'), 'global admin notification preferences must be owned by canonical admin route composition');

    const libraryRoutes = explicitRoutes(librarySelection);
    for (const expected of ['POST /account/libraries', 'POST /account/libraries/:accountId']) {
        assert(libraryRoutes.includes(expected), `customer library owner is missing ${expected}`);
    }
    const passwordRoutes = explicitRoutes(passwordSync);
    for (const expected of ['POST /account/requests/password', 'POST /account/requests/password/sync']) {
        assert(passwordRoutes.includes(expected), `customer password owner is missing ${expected}`);
    }
    assert(explicitRoutes(publicPages).includes('GET /api/platform/plans'), 'public pages must own GET /api/platform/plans');
    assert(adminComposition.includes("require('./admin-actions')") && adminComposition.includes('app.use(createAdminActionsRouter());'), 'admin route composition must own canonical admin actions');

    assert(routerCore.includes('retiredRouterCore'), 'router-core compatibility constructor must be an explicit empty pass-through');
    assert(!routerCore.includes('createRuntimeLegacyRouter'), 'router-core must not delegate to the retired runtime legacy router');
    assert(!routerCore.includes("require('express')"), 'router-core must not construct an independent Express route generation');
    assert(!/\brouter\.(get|post|put|patch|delete)\(/.test(routerCore), 'router-core must not own HTTP handlers');
    for (const obsoleteDependency of [
        '../payments/lifecycle',
        '../payments/stripe',
        '../payments/paypal',
        '../jellyfin/resilient-provisioning',
        '../integrations/request-user-sync',
        '../integrations/email-outbox'
    ]) {
        assert(!routerCore.includes(obsoleteDependency), `router-core still imports superseded route dependency: ${obsoleteDependency}`);
    }

    for (const retiredPath of [
        '/account/register',
        '/account/verify-email',
        '/account/forgot-password',
        '/account/reset-password',
        '/account/checkout/stripe',
        '/account/checkout/paypal',
        '/account/paypal/return',
        '/account/stripe/portal',
        '/account/jellyfin/:accountId/password',
        '/account/trial/start',
        '/account/claim-free/:planCode'
    ]) {
        assert(!routerCore.includes(retiredPath), `replaced route remains in router-core: ${retiredPath}`);
    }

    console.log('platform router composition: ok (legacy router retired; admin ownership explicit; no opaque prefix routers)');
}

try {
    main();
} catch (error) {
    console.error(error.stack || error);
    process.exit(1);
}
