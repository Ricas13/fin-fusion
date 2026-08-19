'use strict';

const fs = require('fs');
const path = require('path');

function read(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function explicitRoutes(source) {
    const routes = [];
    const pattern = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(source))) routes.push(`${match[1].toUpperCase()} ${match[2]}`);
    return routes.sort();
}
function assertOrder(source, markers, label) {
    let previous = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker);
        assert(index >= 0, `${label} missing ${marker}`);
        assert(index > previous, `${label} order changed around ${marker}`);
        previous = index;
    }
}

function main() {
    const platformRouter = read('src/platform/router.js');
    const publicComposition = read('src/platform/public-route-composition.js');
    const customerComposition = read('src/platform/customer-route-composition.js');
    const adminComposition = read('src/platform/admin-runtime-route-composition.js');
    const pathScope = read('src/platform/path-scoped-router.js');
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
    assert(!/\bcreate(?:Admin|Customer|Public)[A-Z]/.test(platformRouter), 'platform router must delegate concrete route factories to composition modules');
    assertOrder(platformRouter, [
        'mountPublicRoutes(router);',
        'mountCustomerAccountRoutes(router);',
        'mountAdminRuntimeRoutes(router);',
        'mountCustomerActionRoutes(router);',
        'router.use(createRuntimeLegacyRouter());'
    ], 'platform route phases');

    assertOrder(publicComposition, [
        'router.use(publicAbuseProtection.middleware);',
        'router.use(createMessagingBotWebhookRouter());',
        'router.use(createPublicPagesRouter());',
        'router.use(createPublicHelpRouter());',
        'router.use(createAccountActivationRouter());',
        'router.use(createCustomerPublicAuthRouter());',
        'router.use(createCustomerLoginRouter());'
    ], 'public route composition');
    assertOrder(customerComposition, [
        'router.use(createCustomerSecurityRouter());',
        'router.use(createCustomerCommunicationsRouter());',
        'router.use(createCustomerStremioRouter());',
        'router.use(createCustomerAffiliateRouter());',
        'router.use(createCustomerDashboardRouter());',
        'router.use(createCustomerActivityRouter());',
        'router.use(createCustomerHistoryRouter());',
        'router.use(createCustomerPaymentReturnRouter());',
        'router.use(createCustomerPlanAcquisitionRouter());'
    ], 'customer route composition');
    assertOrder(adminComposition, [
        'router.use(createAdminOperatorStateRouter());',
        'router.use(createAdminJellyfinLifecycleRouter());',
        'router.use(createAdminCustomerJellyfinPasswordRouter());',
        'router.use(createAdminAutomationRouter());',
        'router.use(createAdminSearchRouter());',
        'router.use(createAdminEventsRouter());',
        "router.get('/admin/configuration-health'",
        'router.use(createAdminPaymentReconciliationRouter());',
        'router.use(createAdminCommerceRouter());',
        'router.use(createAdminStremioSourcesRouter());',
        'router.use(createAdminStremioRouter());',
        'router.use(createAdminPlanDeliveryRouter());',
        'router.use(createAdminPlanOrderRouter());',
        'router.use(createAdminFleetOperationsRouter());',
        'router.use(createAdminProfileAccountRouter());',
        'router.use(createAdminPersonalNotificationTestsRouter());',
        'router.use(createAdminPersonalNotificationPreferencesRouter());',
        'const globalNotificationRouter = createAdminNotificationPreferencesRouter();',
        "onlyPathPrefix('/admin/notifications/preferences', globalNotificationRouter)",
        'router.use(createAdminAbuseProtectionRouter());'
    ], 'admin runtime route composition');
    assert(pathScope.includes("requestPath !== normalized && !requestPath.startsWith(normalized + '/')"), 'path-scoped router must reject unrelated prefixes');
    assert(platformRouter.includes("require('./path-scoped-router')"), 'platform router must re-export the shared path scope helper for compatibility');

    const expectedAcquisition = ['POST /account/claim-free/:planCode', 'POST /account/trial/start'].sort();
    assert(JSON.stringify(explicitRoutes(acquisition)) === JSON.stringify(expectedAcquisition), 'customer plan acquisition route set changed');
    assert(acquisition.includes("scope: 'customer-trial-free'") && acquisition.includes('max: 12') && acquisition.includes('windowSeconds: 300'), 'trial/free rate limit changed');
    assert(acquisition.includes('mutationGuard') && acquisition.includes("require('./customer-session-guard')"), 'trial/free route guards changed');
    assert(acquisition.includes('lifecycle.startFreeTrial') && acquisition.includes('lifecycle.claimFreePlan'), 'trial/free routes must delegate to lifecycle');

    assert(JSON.stringify(explicitRoutes(libraries)) === JSON.stringify(['POST /account/libraries']), 'library selection must have one dedicated POST owner');
    assert(libraries.includes("require('./customer-session-guard')") && libraries.includes('csrf.verify(req)'), 'library selection guards changed');
    assert(libraries.includes('provisioning.setLibrarySelection') && libraries.includes('provisioning.reconcileCustomer'), 'library selection provisioning delegation changed');

    assert(JSON.stringify(explicitRoutes(requestPassword)) === JSON.stringify(['POST /account/requests/password']), 'request-site password must have one dedicated POST owner');
    assert(requestPassword.includes("require('./customer-session-guard')") && requestPassword.includes('csrf.verify(req)'), 'request-site password guards changed');
    assert(requestPassword.includes('requestUserSync.setCustomerPassword'), 'request-site password must delegate to request-user sync');

    assert(JSON.stringify(explicitRoutes(planApi)) === JSON.stringify(['GET /api/platform/plans']), 'public plans API must have one dedicated GET owner');
    assert(planApi.includes('customers.listPublicPlans'), 'public plans API must use the canonical public-plan query');
    assert(sessionGuard.includes('req.session?.customerId && req.session?.customerUserId') && sessionGuard.includes('/account/login?next='), 'shared customer-session guard contract changed');

    assert(explicitRoutes(runtimeLegacy).length === 0, 'runtime legacy wrapper must not own HTTP handlers');
    for (const factory of ['createAdminActionsRouter()','createCustomerLibrarySelectionRouter()','createCustomerRequestPasswordRouter()','createPublicPlanApiRouter()']) {
        assert(runtimeLegacy.includes(factory), `runtime compatibility wrapper must compose ${factory}`);
    }
    for (const dependency of ['../customers','../jellyfin/resilient-provisioning','../integrations/request-user-sync','../jellyfin/policy','../auth/csrf']) {
        assert(!runtimeLegacy.includes(dependency), `runtime compatibility wrapper still owns business dependency: ${dependency}`);
    }

    assert(routerCore.includes('createRuntimeLegacyRouter'), 'router-core compatibility constructor must delegate to compatibility composition');
    assert(!routerCore.includes("require('express')") && !/\brouter\.(get|post|put|patch|delete)\(/.test(routerCore), 'router-core must not own Express handlers');
    for (const dependency of ['../payments/lifecycle','../payments/stripe','../payments/paypal','../jellyfin/resilient-provisioning','../integrations/request-user-sync','../integrations/email-outbox']) {
        assert(!routerCore.includes(dependency), `router-core still imports superseded dependency: ${dependency}`);
    }

    for (const retiredPath of ['/account/register','/account/verify-email','/account/forgot-password','/account/reset-password','/account/checkout/stripe','/account/checkout/paypal','/account/paypal/return','/account/stripe/portal','/account/jellyfin/:accountId/password','/account/trial/start','/account/claim-free/:planCode']) {
        assert(!runtimeLegacy.includes(retiredPath), `replaced route leaked into runtime compatibility wrapper: ${retiredPath}`);
        assert(!routerCore.includes(retiredPath), `replaced route remains in router-core: ${retiredPath}`);
    }

    console.log('platform router composition: ok (route groups explicit; precedence locked; compatibility layers handler-free)');
}

try { main(); }
catch (error) { console.error(error.stack || error); process.exit(1); }
