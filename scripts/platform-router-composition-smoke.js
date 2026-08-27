'use strict';

const fs = require('fs');
const path = require('path');

function read(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
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
    const adminComposition = read('src/platform/admin-route-composition.js');
    const runtimeLegacy = read('src/platform/router-runtime-legacy.js');
    const routerCore = read('src/platform/router-core.js');

    assert(!platformRouter.includes('pruneRoutes'), 'platform router must not prune Express route stacks at runtime');
    assert(!/\.stack\s*=/.test(platformRouter), 'platform router must not mutate Express private .stack internals');
    assert(!platformRouter.includes('core.createRouter()'), 'production must not construct the obsolete router-core route set');
    assert(platformRouter.includes('createRuntimeLegacyRouter()'), 'production must mount the explicit runtime compatibility router');
    assert(!platformRouter.includes('onlyPathPrefix'), 'platform router must not hide child routers behind opaque path-prefix middleware');
    assert(!platformRouter.includes('createAdminNotificationPreferencesRouter'), 'global admin notification preferences must not have a second owner in the platform router');
    assert(adminComposition.includes('app.use(createAdminNotificationPreferencesRouter());'), 'global admin notification preferences must be owned by canonical admin route composition');

    const expected = [
        'GET /api/platform/plans',
        'POST /account/libraries',
        'POST /account/libraries/:accountId',
        'POST /account/requests/password',
        'POST /account/requests/password/sync'
    ].sort();
    const actual = explicitRoutes(runtimeLegacy);
    assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        `runtime legacy route set changed: expected ${expected.join(', ')}; got ${actual.join(', ')}`
    );
    assert(runtimeLegacy.includes('createAdminActionsRouter()'), 'runtime compatibility router must retain canonical admin actions');

    assert(routerCore.includes('createRuntimeLegacyRouter'), 'router-core compatibility constructor must delegate to the explicit runtime legacy router');
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
        assert(!runtimeLegacy.includes(retiredPath), `replaced route leaked into runtime legacy router: ${retiredPath}`);
        assert(!routerCore.includes(retiredPath), `replaced route remains in router-core: ${retiredPath}`);
    }

    console.log('platform router composition: ok (admin ownership explicit; no opaque prefix routers; runtime compatibility routes explicit)');
}

try {
    main();
} catch (error) {
    console.error(error.stack || error);
    process.exit(1);
}
