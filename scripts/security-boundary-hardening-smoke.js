'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const transfer = require('../src/platform/configuration-transfer');
const activity = require('../src/jellyfin/activity');
const outbound = require('../src/security/outbound-url-policy');
const networkIdentity = require('../src/access/network-identity');
const adminStepUp = require('../src/auth/admin-step-up');
const ownerGuard = require('../src/auth/owner-guard');

function request(ip, headers = {}) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]));
    return {
        ip,
        headers: normalized,
        socket: { remoteAddress: ip },
        get(name) { return normalized[String(name).toLowerCase()] || ''; }
    };
}

async function main() {
    const legacy = transfer.normalizeV2Plan({ code: 'legacy', streams: 1 }, { streams: null });
    assert.strictEqual(legacy.streams, null, 'pre-modular V2 imports must preserve the legacy null stream sentinel');

    assert.strictEqual(
        activity.effectiveStreamLimit(null),
        null,
        'accounts without an active entitlement must retain the existing no-concurrent-policy behavior'
    );
    assert.strictEqual(
        activity.effectiveStreamLimit({ jellyfin_access_model: 'household_network', streams: null }),
        null,
        'household-network plans must remain outside concurrent-stream enforcement'
    );
    assert.strictEqual(
        activity.effectiveStreamLimit({ jellyfin_access_model: 'concurrent_streams', streams: null }),
        1,
        'malformed concurrent-stream plans must fail closed to one stream'
    );
    assert.strictEqual(
        activity.effectiveStreamLimit({ jellyfin_access_model: 'concurrent_streams', streams: 4 }),
        4,
        'valid concurrent-stream limits must be preserved'
    );

    // Household IP identity is an authorization boundary. CF-Connecting-IP can
    // be trusted only when Express has independently resolved the effective
    // client hop to a published Cloudflare edge. A forged Cloudflare-looking
    // value inside X-Forwarded-For must never opt a local/direct caller into
    // trusting arbitrary visitor-IP headers.
    assert.strictEqual(
        networkIdentity.requestAddress(request('8.8.8.8', {
            'cf-connecting-ip': '1.1.1.1',
            'x-forwarded-for': '1.1.1.1, 173.245.48.10'
        })),
        '8.8.8.8',
        'a direct public client must remain authoritative even when it forges Cloudflare headers'
    );
    assert.strictEqual(
        networkIdentity.requestAddress(request('172.18.0.5', {
            'cf-connecting-ip': '8.8.8.8',
            'x-forwarded-for': '8.8.8.8, 173.245.48.10'
        })),
        '',
        'a private proxy hop must fail closed instead of trusting a Cloudflare address supplied only in X-Forwarded-For'
    );
    assert.strictEqual(
        networkIdentity.requestAddress(request('173.245.48.10', {
            'cf-connecting-ip': '8.8.8.8',
            'x-forwarded-for': '8.8.8.8, 173.245.48.10'
        })),
        '8.8.8.8',
        'a proven Cloudflare edge may supply the original public visitor address'
    );
    assert.strictEqual(
        networkIdentity.requestAddress(request('173.245.48.10', {
            'cf-connecting-ip': '192.168.1.20'
        })),
        '',
        'Cloudflare visitor headers containing non-public addresses must fail closed'
    );
    assert.strictEqual(
        networkIdentity.requestAddress(request('2606:4700::1234', {
            'cf-connecting-ip': '2001:4860:4860::8888'
        })),
        '2001:4860:4860::8888',
        'published Cloudflare IPv6 edges must preserve public IPv6 visitor identity'
    );
    assert.strictEqual(
        networkIdentity.requestAddress(request('173.245.48.10', {
            'x-forwarded-for': '8.8.4.4, 173.245.48.10'
        })),
        '8.8.4.4',
        'X-Forwarded-For fallback is allowed only after the effective hop is independently proven to be Cloudflare'
    );

    const customers = read('src/customers.js');
    const dummyHash = /const DUMMY_CUSTOMER_PASSWORD_HASH='([^']+)'/.exec(customers)?.[1];
    assert(dummyHash, 'customer authentication must define a fixed dummy bcrypt hash');
    assert(/^\$2[aby]\$12\$/.test(dummyHash), 'dummy login hash must use the same bcrypt cost as customer passwords');
    assert.strictEqual(await bcrypt.compare('definitely-not-the-dummy-password', dummyHash), false, 'dummy bcrypt hash must be valid');
    assert(
        customers.includes('if(!row||!row.active){await bcrypt.compare(password,DUMMY_CUSTOMER_PASSWORD_HASH);return null}'),
        'unknown and inactive customer logins must execute a bcrypt comparison before returning'
    );

    const activation = read('src/auth/account-activation.js');
    assert(activation.includes("require('../security/password-breach')"), 'customer activation must use the shared breach-password service');
    assert(
        activation.includes('await passwordBreach.assertNotBreached(password);const passwordHash=await bcrypt.hash(password,12)'),
        'activation passwords must be screened before hashing and persistence'
    );

    for (const address of ['64:ff9b::a9fe:a9fe', '64:ff9b:1:a9fe:a9:fe00::']) {
        assert.strictEqual(outbound.nat64Ipv4(address), '169.254.169.254', `NAT64 metadata embedding must decode for ${address}`);
        const classification = outbound.classify(address);
        assert(classification.hard && classification.private && /metadata|link-local/.test(classification.reason), `NAT64 metadata embedding must be blocked for ${address}`);
    }

    // Every per-customer admin POST is security-sensitive. New child actions
    // must inherit step-up automatically rather than relying on a route-name list.
    const customerMutationPaths = [
        '/admin/users/00000000-0000-0000-0000-000000000001/manage/account',
        '/admin/users/00000000-0000-0000-0000-000000000001/permanent-access',
        '/admin/users/00000000-0000-0000-0000-000000000001/assign-server',
        '/admin/users/00000000-0000-0000-0000-000000000001/stremio-household/reset'
    ];
    for (const route of customerMutationPaths) {
        assert.strictEqual(adminStepUp.sensitive({ method: 'POST', path: route }), true, `admin step-up must protect ${route}`);
        assert.strictEqual(adminStepUp.sensitive({ method: 'GET', path: route }), false, `admin step-up must not gate read-only GET ${route}`);
    }

    // Service-credit redemption creates a paid entitlement and therefore must
    // obey the same emergency commerce pause and serialized capacity check as
    // provider/free/trial acquisition paths.
    const affiliateCredits = read('src/affiliate-credits.js');
    assert(affiliateCredits.includes("require('./payments/commerce-control')"), 'affiliate redemption must use the commerce freeze control');
    assert(affiliateCredits.includes("require('./entitlements/plan-capacity')"), 'affiliate redemption must use the shared plan-capacity service');
    assert(affiliateCredits.includes('await commerce.assertOpen();'), 'affiliate redemption must fail closed while commerce is paused');
    assert(affiliateCredits.includes("await planCapacity.lockAndAssert(client,plan.id,plan.name||'This plan');"), 'affiliate redemption must serialize and re-check plan capacity');
    assert(
        affiliateCredits.indexOf('await planCapacity.lockAndAssert') < affiliateCredits.indexOf('INSERT INTO subscriptions'),
        'affiliate capacity must be re-checked before the subscription is inserted'
    );

    const abuseProtection = read('src/security/public-abuse-protection.js');
    assert(
        abuseProtection.includes("const { query, transaction } = require('../db');"),
        'public abuse-protection settings must use the shared database transaction helper'
    );
    assert(
        abuseProtection.includes('await transaction(async client => {'),
        'public abuse-protection settings must save inside a database transaction'
    );
    assert(
        abuseProtection.includes('SELECT setting_value FROM platform_settings WHERE setting_key=$1 FOR UPDATE'),
        'public abuse-protection settings must serialize concurrent edits'
    );
    const abuseSaveStart = abuseProtection.indexOf('async function save(');
    const abuseSaveEnd = abuseProtection.indexOf('\nfunction shouldProtect(', abuseSaveStart);
    const abuseSave = abuseProtection.slice(abuseSaveStart, abuseSaveEnd);
    assert(
        (abuseSave.match(/await client\.query\(/g) || []).length >= 3,
        'public abuse-protection settings read, write and audit must share the same transaction client'
    );
    assert(
        abuseSave.indexOf("INSERT INTO platform_settings") < abuseSave.indexOf("INSERT INTO audit_log"),
        'public abuse-protection settings must persist before the audit row within one atomic transaction'
    );

    const application = read('src/application.js');
    assert(
        application.includes("res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');"),
        'every CAPTAiNFiN response must carry the global no-index header'
    );
    assert(
        application.includes("app.set('trust proxy', trustProxySetting());"),
        'Express client identity must remain behind the explicit trust-proxy policy'
    );
    assert(
        application.includes("fail('TRUST_PROXY must list trusted proxy addresses/ranges") && !application.includes("return true; // trust every proxy"),
        'trust-proxy configuration must reject blanket/hop-count trust'
    );
    const compose = read('docker-compose.yml');
    assert(compose.includes('TRUST_PROXY: ${TRUST_PROXY:-loopback, linklocal, uniquelocal}'), 'Compose must trust only local/private reverse-proxy hops by default');
    assert(compose.includes('"127.0.0.1:3030:3030"'), 'the web runtime must remain loopback-bound so public clients cannot bypass the reverse proxy');

    // GET /logout is retained only as a compatibility/confirmation URL. It must
    // never revoke or destroy a session; the actual mutation is POST + CSRF.
    const staffController = read('src/auth/staff-controller.js');
    const logoutFlow = read('src/platform/logout.js');
    assert(
        staffController.includes('async function logout(req,res,next){return logoutFlow.confirmation(req,res,next)}'),
        'legacy GET /logout wiring must delegate only to the non-mutating confirmation page'
    );
    assert(staffController.includes("router.post('/logout',logoutFlow.logout)"), 'logout mutation must have an explicit POST owner');
    assert(logoutFlow.includes('if(!csrf.verify(req))'), 'logout POST must verify the session CSRF token before mutation');
    assert(logoutFlow.includes('staffAuth.markSessionLoggedOut'), 'staff logout must revoke the authoritative staff auth session');
    assert(logoutFlow.includes("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW())"), 'customer logout must revoke its auth_sessions row before destroying the browser session');
    const confirmationStart = logoutFlow.indexOf('async function confirmation(');
    const confirmationEnd = logoutFlow.indexOf('\nasync function logout(', confirmationStart);
    const confirmationSource = logoutFlow.slice(confirmationStart, confirmationEnd);
    assert(!confirmationSource.includes('destroy(req)')&&!confirmationSource.includes('markSessionLoggedOut')&&!confirmationSource.includes('revoked_at'), 'GET logout confirmation must remain side-effect free');
    assert(logoutFlow.includes("res.clearCookie(process.env.SESSION_COOKIE_NAME||'steamfusion.sid',{path:'/'})"), 'logout must clear the browser session cookie after revocation');

    const robots = read('public/robots.txt');
    assert(/User-agent:\s*\*/i.test(robots), 'robots.txt must target all crawlers');
    assert(/^Disallow:\s*$/im.test(robots), 'robots.txt must allow crawling so known URLs can receive the noindex response header');
    assert(!/Disallow:\s*\//i.test(robots), 'robots.txt must not block crawlers from observing noindex');

    const roles = read('scripts/configure-runtime-db-roles.js');
    assert((roles.match(/REVOKE UPDATE,DELETE ON audit_log FROM \$\{role\}/g) || []).length >= 2, 'web and automation role refreshes must preserve audit-log append-only privileges');

    const migration = read('db/migrations/036_security_boundary_hardening.sql');
    for (const token of [
        'plans_jellyfin_stream_contract_check',
        'access_network_leases_customer_idx',
        'REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM steamfusion_app',
        'REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM steamfusion_automation'
    ]) {
        assert(migration.includes(token), `security migration is missing ${token}`);
    }

    // Owner/support split: existing admins are promoted exactly once when the
    // column is introduced; future admins remain support-only by default.
    const ownerMigration = read('db/migrations/107_admin_owner_capability.sql');
    const firstRun = read('src/auth/first-run-setup.js');
    const adminComposition = read('src/platform/admin-route-composition.js');
    assert(ownerMigration.includes("column_name='is_owner'"), 'owner migration must detect first introduction before backfilling existing admins');
    assert(ownerMigration.includes('ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT FALSE'), 'new administrators must default to support-only');
    assert(ownerMigration.includes("WHERE role='admin'"), 'pre-split administrators must retain owner authority');
    assert(firstRun.includes('legacy_numeric_id,is_owner'), 'first-run administrator creation must explicitly set owner capability');
    assert(firstRun.includes("'admin',TRUE,$4,TRUE"), 'the installation owner must be created with owner capability');
    assert.strictEqual(ownerGuard.isOwnerOnlyPath('/settings/support'), true, 'platform settings must be owner-only');
    assert.strictEqual(ownerGuard.isOwnerOnlyPath('/payments/stripe'), true, 'payment credentials must be owner-only');
    assert.strictEqual(ownerGuard.isOwnerOnlyPath('/notifications/preferences/delivery'), true, 'messaging credentials must be owner-only');
    assert.strictEqual(ownerGuard.isOwnerOnlyPath('/email'), true, 'email infrastructure must be owner-only');
    assert.strictEqual(ownerGuard.isOwnerOnlyPath('/users/00000000-0000-0000-0000-000000000001'), false, 'support must retain customer operations');
    assert.strictEqual(ownerGuard.isOwnerOnlyPath('/support/tickets'), false, 'support must retain ticket operations');
    assert(
        adminComposition.indexOf("app.use('/admin', adminMutationRateLimit);") < adminComposition.indexOf("app.use('/admin', ownerBoundary);"),
        'existing admin mutation rate limiting must run before owner authorization'
    );

    // Stremio installation credentials are bearer secrets. The portal must say
    // so explicitly, and customer communications must not acquire a code path
    // that reads installation credentials for outbound delivery.
    const customerStremio = read('src/platform/customer-stremio.js');
    const customerDashboard = read('views/customer/dashboard.ejs');
    const customerCommunications = read('src/platform/customer-communications.js');
    assert(/secret bearer link/.test(customerStremio)&&/treat it like a password/.test(customerStremio), 'new Stremio links must be described as bearer secrets');
    assert(/Keep this link private/.test(customerDashboard), 'the persistent Stremio UI must warn customers to keep the manifest private');
    assert(!customerCommunications.includes('install-credential-recovery')&&!customerCommunications.includes('stremioManifestUrl'), 'outbound customer communications must not read or send Stremio bearer credentials');

    // Stored community settings should degrade safely if an older/bad value is
    // present rather than making the admin/customer dashboard unrenderable.
    const notificationSettings = read('src/integrations/notification-settings.js');
    assert(notificationSettings.includes('function communityForLoad'), 'notification settings must have a tolerant load-normalization path');
    assert(notificationSettings.includes('const safe=(parse,fallback)=>{try{return parse()}catch{return fallback}}'), 'malformed saved community settings must fall back safely on load');

    console.log('security boundary hardening smoke: ok');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
