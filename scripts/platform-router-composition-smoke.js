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
    const libraries = read('src/platform/customer-library-selection.js');
    const requestPassword = read('src/platform/customer-request-password.js');
    const planApi = read('src/platform/public-plan-api.js');
    const sessionGuard = read('src/platform/customer-session-guard.js');

    assert(!platformRouter.includes('pruneRoutes'), 'platform router must not prune Express route stacks at runtime');
    assert(!/\.stack\s*=/.test(platformRouter), 'platform router must not mutate Express private .stack internals');
    assert(!platformRouter.includes('core.createRouter()'), 'production must not construct the obsolete router-core route set');
    assert(platformRouter.includes('createRuntimeLegacyRouter()'), 'production must mount the compatibility composition wrapper');
    assert(
        platformRouter.includes("onlyPathPrefix('/admin/notifications/preferences', globalNotificationRouter)"),
        'global notification compatibility router must be constrained to its canonical URL prefix'
    );
    assert(platformRouter.includes('createCustomerPlanAcquisitionRouter()'), 'platform router must mount the dedicated customer plan acquisition router');
    assert(!platformRouter.includes("router.post('/account/trial/start'"), 'trial acquisition must not be implemented inline in platform router');
    assert(!platformRouter.includes("router.post('/account/claim-free/:planCode'"), 'free-plan acquisition must not be implemented inline in platform router');
    assert(!platformRouter.includes("require('../payments/lifecycle')"), 'platform catch-all must not own acquisition lifecycle policy');

    const expectedAcquisition = ['POST /account/claim-free/:planCode', 'POST /account/trial/start'].sort();
    assert(
        JSON.stringify(explicitRoutes(acquisition)) === JSON.stringify(expectedAcquisition),
        `customer plan acquisition route set changed: expected ${expectedAcquisition.join(', ')}`
    );
    assert(acquisition.includes("scope: 'customer-trial-free'"), 'trial/free acquisition must retain its dedicated rate-limit scope');
    assert(acquisition.includes('max: 12'), 'trial/free acquisition rate limit changed unexpectedly');
    assert(acquisition.includes('windowSeconds: 300'), 'trial/free acquisition rate-limit window changed unexpectedly');
    assert(acquisition.includes('mutationGuard'), 'trial/free acquisition must retain mutation/CSRF protection');
    assert(acquisition.includes("require('./customer-session-guard')"), 'trial/free acquisition must use the shared customer-session guard');
    assert(acquisition.includes('lifecycle.startFreeTrial'), 'trial acquisition must delegate to canonical lifecycle service');
    assert(acquisition.includes('lifecycle.claimFreePlan'), 'free acquisition must delegate to canonical lifecycle service');

    assert(JSON.stringify(explicitRoutes(libraries)) === JSON.stringify(['POST /account/libraries']), 'library selection must have one dedicated POST owner');
    assert(libraries.includes("require('./customer-session-guard')"), 'library selection must use the shared customer-session guard');
    assert(libraries.includes('csrf.verify(req)'), 'library selection must retain CSRF verification');
    assert(libraries.includes('provisioning.setLibrarySelection'), 'library selection must delegate persistence to provisioning');
    assert(libraries.includes('provisioning.reconcileCustomer'), 'library selection must reconcile access after a change');

    assert(JSON.stringify(explicitRoutes(requestPassword)) === JSON.stringify(['POST /account/requests/password']), 'request-site password must have one dedicated POST owner');
    assert(requestPassword.includes("require('./customer-session-guard')"), 'request-site password must use the shared customer-session guard');
    assert(requestPassword.includes('csrf.verify(req)'), 'request-site password must retain CSRF verification');
    assert(requestPassword.includes('requestUserSync.setCustomerPassword'), 'request-site password must delegate to request-user sync');

    assert(JSON.stringify(explicitRoutes(planApi)) === JSON.stringify(['GET /api/platform/plans']), 'public plans API must have one dedicated GET owner');
    assert(planApi.includes('customers.listPublicPlans'), 'public plans API must use the canonical public-plan query');

    assert(sessionGuard.includes('req.session?.customerId && req.session?.customerUserId'), 'shared customer-session guard must require both customer identifiers');
    assert(sessionGuard.includes('/account/login?next='), 'shared customer-session guard must preserve return navigation');

    assert(explicitRoutes(runtimeLegacy).length === 0, 'runtime legacy wrapper must not own HTTP handlers');
    for (const factory of [
        'createAdminActionsRouter()',
        'createCustomerLibrarySelectionRouter()',
        'createCustomerRequestPasswordRouter()',
        'createPublicPlanApiRouter()'
    ]) assert(runtimeLegacy.includes(factory), `runtime compatibility wrapper must compose ${factory}`);
    for (const obsoleteDependency of [
        '../customers',
        '../jellyfin/resilient-provisioning',
        '../integrations/request-user-sync',
        '../jellyfin/policy',
        '../auth/csrf'
    ]) assert(!runtimeLegacy.includes(obsoleteDependency), `runtime compatibility wrapper still owns business dependency: ${obsoleteDependency}`);

    assert(routerCore.includes('createRuntimeLegacyRouter'), 'router-core compatibility constructor must delegate to the compatibility composition wrapper');
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
        assert(!runtimeLegacy.includes(retiredPath), `replaced route leaked into runtime compatibility wrapper: ${retiredPath}`);
        assert(!routerCore.includes(retiredPath), `replaced route remains in router-core: ${retiredPath}`);
    }

    console.log('platform router composition: ok (compatibility wrapper is composition-only; customer/API handlers have explicit owners)');
}

try {
    main();
} catch (error) {
    console.error(error.stack || error);
    process.exit(1);
}
