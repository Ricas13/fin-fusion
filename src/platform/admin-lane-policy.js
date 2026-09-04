'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const policy = require('../jellyfin/policy');
const overrides = require('../jellyfin/lane-policy-overrides');
const subscriptionState = require('../entitlements/subscription-state');
const provisioning = require('../jellyfin/resilient-provisioning');

function gate(req,res,next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function targetLane(value) { return overrides.lane(value || 'primary'); }
// Which Jellyfin lanes (Premium/Free Access) this customer currently holds.
// Consumed by customer-360-access-cards.js to render one Access/Libraries/
// Requests panel per lane the customer actually holds.
async function laneEntitlements(customerId) {
    const [primaryRaw, free] = await Promise.all([
        subscriptionState.effectiveSubscription(customerId, { includeBlocked: true }),
        subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true })
    ]);
    return { primary: primaryRaw && !primaryRaw.is_free_tier ? primaryRaw : null, free: free || null };
}

function createAdminLanePolicyRouter() {
    const router = express.Router();

    router.post('/admin/users/:customerId/lane-policy-overrides', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const accessLane = targetLane(req.body.accessLane);
        try {
            const changed = [];
            for (const field of policy.TECHNICAL_FIELDS) {
                if (req.body[field] === undefined) continue;
                const raw = String(req.body[field]).trim();
                if (raw === '') await overrides.resetPolicyOverrideField(req.params.customerId,accessLane,field,req.session.authUserId);
                else if (field === 'streams') await overrides.setPolicyOverrideField(req.params.customerId,accessLane,field,Number.parseInt(raw,10),req.session.authUserId);
                else {
                    if (!['true','false'].includes(raw)) throw new Error(`Invalid ${field} override.`);
                    await overrides.setPolicyOverrideField(req.params.customerId,accessLane,field,raw === 'true',req.session.authUserId);
                }
                changed.push(field);
            }
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.lane_policy_override','customer',$2,$3::jsonb)`, [req.session.authUserId,req.params.customerId,JSON.stringify({ accessLane, fields: changed })]);
            let note = '';
            try { await provisioning.reconcileCustomer(req.params.customerId); } catch (_) { note = ' Jellyfin reconciliation is still catching up.'; }
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&message=${encodeURIComponent(`${accessLane === 'free' ? 'Free' : 'Premium'} policy overrides saved.${note}`)}`);
        } catch (error) {
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&error=${encodeURIComponent(error.message)}`);
        }
    });

    router.post('/admin/users/:customerId/lane-policy-overrides/reset-all', gate, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const accessLane = targetLane(req.body.accessLane);
        try {
            await overrides.resetAllPolicyOverrides(req.params.customerId,accessLane,req.session.authUserId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.lane_policy_override_reset_all','customer',$2,$3::jsonb)`, [req.session.authUserId,req.params.customerId,JSON.stringify({ accessLane })]);
            try { await provisioning.reconcileCustomer(req.params.customerId); } catch (_) {}
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&message=${encodeURIComponent(`${accessLane === 'free' ? 'Free' : 'Premium'} policy reset to plan.`)}`);
        } catch (error) {
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&error=${encodeURIComponent(error.message)}`);
        }
    });

    return router;
}

module.exports = { createAdminLanePolicyRouter, laneEntitlements };
