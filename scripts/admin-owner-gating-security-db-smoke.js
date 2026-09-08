'use strict';

require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const ownerGuard = require('../src/auth/owner-guard');
const stepUp = require('../src/auth/admin-step-up');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { users: [] };

async function createAdmin(label, isOwner) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(18).toString('base64url'), 12);
    const result = await query(
        `INSERT INTO app_users(username,email,password_hash,role,active,is_owner) VALUES($1,$2,$3,'admin',TRUE,$4) RETURNING id`,
        [`owner-gating-${label}-${suffix}`, `owner-gating-${label}-${suffix}@example.invalid`, passwordHash, isOwner]
    );
    created.users.push(result.rows[0].id);
    return result.rows[0].id;
}

function requireSensitive(method, path) {
    const matched = stepUp.sensitive({ method, path, originalUrl: path });
    assert.strictEqual(matched, true, `${method} ${path} must require step-up MFA re-verification`);
}

function requireNotSensitive(method, path) {
    const matched = stepUp.sensitive({ method, path, originalUrl: path });
    assert.strictEqual(matched, false, `${method} ${path} must not be treated as a step-up mutation`);
}

(async () => {
    // 1. ownerStatus() must correctly distinguish an owner admin from an
    // ordinary (support) admin - this is the exact primitive both
    // admin-prorata-refunds.js and admin-bulk-customers.js now depend on to
    // gate real cash refunds and permanent customer deletion.
    const ownerId = await createAdmin('owner', true);
    const supportId = await createAdmin('support', false);
    assert.strictEqual(await ownerGuard.ownerStatus(ownerId), true, 'an is_owner=TRUE active admin must be recognized as owner');
    assert.strictEqual(await ownerGuard.ownerStatus(supportId), false, 'an is_owner=FALSE admin must not be recognized as owner');
    assert.strictEqual(await ownerGuard.ownerStatus(null), false, 'a missing user id must never resolve as owner');

    // 2. Cash refunds (admin-prorata-refunds.js) must gate their entire
    // route surface behind requireOwner - not just the generic "is admin"
    // gate() used everywhere else in that router file. Verified as a wiring
    // check against the actual middleware chain source, since the security
    // property under test IS "is requireOwner actually in this chain",
    // which ownerStatus()'s own behavioral test above cannot observe from
    // outside the route registration.
    const refundsSource = fs.readFileSync(require.resolve('../src/platform/admin-prorata-refunds'), 'utf8');
    assert(refundsSource.includes("require('../auth/owner-guard')"), 'admin-prorata-refunds.js must import the owner-guard module');
    assert(/router\.use\(['"]\/admin\/refunds['"][^)]*requireOwner/.test(refundsSource), 'the /admin/refunds route surface must require owner access, not just any admin session');

    // 3. Permanent portal-customer deletion (the "portal_delete" bulk action)
    // must be owner-gated. It is one action among many in a shared bulk
    // router that other, lower-impact actions must remain available to
    // ordinary admins for, so the check must be specific to the immediate
    // (irreversible) action path rather than the whole router.
    const bulkSource = fs.readFileSync(require.resolve('../src/platform/admin-bulk-customers'), 'utf8');
    assert(bulkSource.includes("require('../auth/owner-guard')"), 'admin-bulk-customers.js must import the owner-guard module');
    assert(/meta\.immediate&&!\(await ownerStatus\(req\.session\.authUserId\)\)/.test(bulkSource), 'an immediate (irreversible) bulk action, e.g. permanent portal deletion, must require owner access before executing');

    // 4. Step-up MFA (a second, independent defense-in-depth layer against a
    // hijacked admin session) must cover the same money/credential-moving
    // routes. These are behavioral checks against the real exported
    // sensitive() matcher, not string search - each assertion proves the
    // actual route path a browser would POST to is or isn't matched.
    requireSensitive('POST', '/admin/refunds/00000000-0000-0000-0000-000000000000');
    requireSensitive('POST', '/admin/billing/00000000-0000-0000-0000-000000000000/resume-renewal');
    requireSensitive('POST', '/admin/billing/discover/apply');
    requireSensitive('POST', '/admin/settings/integrations/payments/stripe');
    requireSensitive('POST', '/admin/customer-jellyfin-password/cust-1/acct-1');
    requireSensitive('POST', '/admin/customers/bulk/confirm');
    requireNotSensitive('GET', '/admin/refunds');
    requireNotSensitive('POST', '/admin/dashboard');

    console.log('admin owner-gating security DB smoke: ok');
})().finally(async () => {
    for (const userId of created.users.reverse()) {
        await query('DELETE FROM app_users WHERE id=$1', [userId]).catch(() => {});
    }
    await getPool().end();
}).catch((error) => {
    console.error('admin owner-gating security DB smoke failed:', error);
    process.exit(1);
});
