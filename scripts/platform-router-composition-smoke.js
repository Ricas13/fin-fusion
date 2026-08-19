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
    const runtimeLegacy = read('src/platform/router-runtime-legacy.js');
    const routerCore = read('src/platform/router-core.js');
    const acquisition = read('src/platform/customer-plan-acquisition.js');

    assert(!platformRouter.includes('pruneRoutes'), 'platform router must not prune Express route stacks at runtime');
    assert(!/\.stack\s*=/.test(platformRouter), 'platform router must not mutate Express private .stack internals');
    assert(!platformRouter.includes('core.createRouter()'), 'production must not construct the obsolete router-core route set');
    assert(platformRouter.includes('createRuntimeLegacyRouter()'), 'production must mount the explicit runtime compatibility router');
    assert(
        platformRouter.includes("onlyPathPrefix('/admin/notifications/preferences', globalNotificationRouter)"),
        'global notification compatibility router must be constrained to its canonical URL prefix'
    );
    assert(platformRouter.includes('createCustomerPlanAcquisitionRouter()'), 'platform router must mount the dedicated customer plan acquisition router');
    assert(!platformRouter.includes("router.post('/account/trial/start'"), 'trial acquisition must not be implemented inline in platform router');
    assert(!platformRouter.includes("router.post('/account/claim-free/:planCode'"), 'free-plan acquisition must not be implemented inline in platform router');
    assert(!platformRouter.includes("require('../payments/lifecycle')"), 'platform catch-all must not own acquisition lifecycle policy');

    const acquisitionRoutes = explicitRoutes(acquisition);
    const expectedAcquisition = [
        'POST /account/claim-free/:planCode',
        'POST /account/trial/start'
    ].sort();
    assert(
        JSON.stringify(acquisitionRoutes) === JSON.stringify(expectedAcquisition),
        `customer plan acquisition route set changed: expected ${expectedAcquisition.join(', ')}; got ${acquisitionRoutes.join(', ')}`
    );
    assert(acquisition.includes("scope: 'customer-trial-free'"), 'trial/free acquisition must retain its dedicated rate-limit scope');
    assert(acquisition.includes('max: 12'), 'trial/free acquisition rate limit changed unexpectedly');
    assert(acquisition.includes('windowSeconds: 300'), 'trial/free acquisition rate-limit window changed unexpectedly');
    assert(acquisition.includes('mutationGuard'), 'trial/free acquisition must retain mutation/CSRF protection');
    assert(acquisition.includes('requireCustomer'), 'trial/free acquisition must require an authenticated customer');
    assert(acquisition.includes('lifecycle.startFreeTrial'), 'trial acquisition must delegate to canonical lifecycle service');
    assert(acquisition.includes('lifecycle.claimFreePlan'), 'free acquisition must delegate to canonical lifecycle service');

    const expected = [
        'GET /api/platform/plans',
        'POST /account/libraries',
        'POST /account/requests/password'
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

    console.log('platform router composition: ok (explicit compatibility routes; acquisition routes have a dedicated owner)');
}

try {
    main();
} catch (error) {
    console.error(error.stack || error);
    process.exit(1);
}
