'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const provisioning = require('../jellyfin/provisioning');
const manualSubscriptions = require('../entitlements/manual-subscriptions');
const manualAssignment = require('../jellyfin/manual-assignment');
const planServers = require('../jellyfin/plan-servers');

const METHODS = new Set(['paypal', 'stripe', 'bank', 'other']);
const CURRENCIES = new Set(['GBP', 'USD', 'EUR']);

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function text(value, max = 500) { return String(value || '').trim().slice(0, max); }
function isoDate(value) {
    const raw = text(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('Enter a valid date.');
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new Error('Enter a valid date.');
    return date;
}
function moneyMinor(value) {
    const raw = text(value, 30);
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a valid non-negative amount with no more than two decimal places.');
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new Error('Amount must be between 0 and 100,000.');
    return Math.round(amount * 100);
}
function recognizedProviderReference(method, externalReference) {
    const ref = text(externalReference, 255);
    if (method === 'stripe' && /^sub_[A-Za-z0-9_\-]+$/.test(ref)) return ref;
    if (method === 'paypal' && /^I-[A-Za-z0-9\-]+$/i.test(ref)) return ref;
    return null;
}
function customerPath(customerId, tab, key = '', message = '') {
    const notice = key ? `&${encodeURIComponent(key)}=${encodeURIComponent(message)}` : '';
    return `/admin/users/${encodeURIComponent(customerId)}?tab=${encodeURIComponent(tab)}${notice}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(dateText, days) {
    const d = isoDate(dateText);
    d.setUTCDate(d.getUTCDate() + Number(days || 30));
    return d.toISOString().slice(0, 10);
}
function effectivePrimarySql() {
    return `
        s.superseded_by IS NULL
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND s.starts_at<=NOW()
        AND (
            (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
            OR (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
            OR (
                COALESCE(s.service_extension_days,0)>0
                AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
                AND (s.current_period_end + ((s.service_extension_days || ' days')::interval))>NOW()
            )
        )`;
}
async function grantPlans() {
    const result = await query(`
        SELECT id,code,name,service_type,server_class,billing_interval,duration_days,price_minor,currency
        FROM plans
        WHERE active=TRUE
          AND archived_at IS NULL
          AND (effective_from IS NULL OR effective_from<=NOW())
          AND (effective_until IS NULL OR effective_until>NOW())
          AND audience IN('direct','both')
          AND COALESCE(is_addon,FALSE)=FALSE
          AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio')
        ORDER BY sort_order,price_minor,name
    `);
    return result.rows;
}
function serverCapacityLabel(server) {
    const users = Number(server.assigned_users || 0), max = Number(server.max_users || 0);
    if (!max) return `${users} user${users === 1 ? '' : 's'} · no configured limit`;
    if (users > max) return `${users}/${max} · OVER +${users - max}`;
    if (users === max) return `${users}/${max} · FULL`;
    return `${users}/${max} · ${max - users} left`;
}
async function eligibleServersForGrant(plan) {
    if (!['jellyfin', 'bundle'].includes(String(plan.service_type || 'jellyfin'))) return [];
    const raw = await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true });
    const kind = manualAssignment.accessKind(plan);
    const servers = [];
    for (const server of raw) {
        if (!server.allow_new_users) continue;
        if (kind === 'trial' && !server.trial_enabled) continue;
        if (kind === 'paid' && !server.paid_enabled) continue;
        const users = await manualAssignment.assignedUsers(server.id);
        servers.push({ id: server.id, name: server.name, health_status: server.health_status, assigned_users: users, max_users: Number(server.max_users || 0) });
    }
    return servers;
}
async function serversByPlan(plans) {
    const map = new Map();
    for (const plan of plans) map.set(plan.id, await eligibleServersForGrant(plan));
    return map;
}
async function currentPrimarySubscription(customerId) {
    const result = await query(`
        SELECT s.id,s.status,s.current_period_end,p.name AS plan_name
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
        WHERE s.customer_id=$1 AND ${effectivePrimarySql()}
        ORDER BY s.created_at DESC
        LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}
function serverOptionsHtml(servers) {
    if (!servers.length) return '<option value="">Automatic placement (no eligible server found yet)</option>';
    return `<option value="">Automatic placement</option>${servers.map(server => `<option value="${esc(server.id)}">${esc(server.name)} · ${esc(server.health_status || 'unknown')} · ${esc(serverCapacityLabel(server))}</option>`).join('')}`;
}
function grantForm(req, customerId, plans, serversByPlanMap = new Map()) {
    if (!plans.length) return '<div class="operatorCallout warn"><strong>No grantable direct-customer plans are currently active.</strong></div>';
    const start = today();
    const first = plans[0];
    const end = addDays(start, Number(first.duration_days || 30));
    const options = plans.map(plan => `<option value="${esc(plan.id)}" data-days="${esc(plan.duration_days || 30)}" data-amount="${esc((Number(plan.price_minor || 0) / 100).toFixed(2))}" data-currency="${esc(plan.currency || 'GBP')}" data-service="${esc(plan.service_type || 'jellyfin')}" data-servers="${esc(JSON.stringify(serversByPlanMap.get(plan.id) || []))}">${esc(plan.name)} · ${esc(String(plan.service_type || 'jellyfin').replace(/^./, c => c.toUpperCase()))}</option>`).join('');
    const firstServers = serversByPlanMap.get(first.id) || [];
    const serverField = ['jellyfin', 'bundle'].includes(String(first.service_type || 'jellyfin'))
        ? `<div class="formGroup" id="manualGrantServerGroup"><label>Jellyfin server</label><select class="input" name="serverId" id="manualGrantServer">${serverOptionsHtml(firstServers)}</select><div class="inlineHelp">Automatic placement follows normal capacity rules. Choosing a specific server here creates access immediately and <strong>can exceed that server's configured capacity</strong> — use this deliberately.</div></div>`
        : `<div class="formGroup" id="manualGrantServerGroup" hidden><select class="input" name="serverId" id="manualGrantServer"><option value="">Automatic placement</option></select></div>`;
    return `<section class="section" id="manual-entitlement-grant"><div class="sectionHead"><div><h2>Record off-platform payment / grant plan</h2><div class="muted">Create local access for a customer who has no current primary subscription. This records the administrator action only; it does not create a provider checkout, webhook or recurring-provider link.</div></div><span class="pill warn">Manual grant</span></div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manual-grant" data-native-submit="true"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="returnTab" value="${esc(req.query.tab === 'billing' ? 'billing' : 'access')}"><div class="formGrid"><div class="formGroup"><label>Plan</label><select class="input" name="planId" id="manualGrantPlan" required>${options}</select></div>${serverField}<div class="formGroup"><label>Payment / grant method</label><select class="input" name="method" required><option value="paypal">PayPal</option><option value="stripe">Stripe</option><option value="bank">Bank transfer</option><option value="other">Other / complimentary</option></select></div><div class="formGroup"><label>Start date</label><input class="input" type="date" name="startDate" id="manualGrantStart" value="${esc(start)}" required></div><div class="formGroup"><label>End date</label><input class="input" type="date" name="endDate" id="manualGrantEnd" value="${esc(end)}" required><div class="inlineHelp">Defaults to the selected plan duration. You can override it before saving.</div></div><div class="formGroup"><label>Amount recorded</label><input class="input" name="amount" id="manualGrantAmount" inputmode="decimal" value="${esc((Number(first.price_minor || 0) / 100).toFixed(2))}" required></div><div class="formGroup"><label>Currency</label><select class="input" name="currency" id="manualGrantCurrency"><option value="GBP" ${first.currency === 'GBP' ? 'selected' : ''}>GBP</option><option value="USD" ${first.currency === 'USD' ? 'selected' : ''}>USD</option><option value="EUR" ${first.currency === 'EUR' ? 'selected' : ''}>EUR</option></select></div><div class="formGroup"><label>External reference</label><input class="input" name="externalReference" maxlength="255" placeholder="PayPal transaction / I-… or Stripe reference / sub_…"><div class="inlineHelp">Stored in the audit record only. Even a PayPal <code>I-…</code> or Stripe <code>sub_…</code> reference does not convert this manual grant into a provider-managed recurring subscription.</div></div><div class="formGroup"><label>Admin note</label><input class="input" name="note" maxlength="500" placeholder="Why this access was granted"></div></div><label class="securityNote standalone"><input type="checkbox" name="confirm" value="1" required> I understand this records local access/payment information only and <strong>does not charge the provider</strong>. Automatic renewal remains off.</label><button class="button" type="submit">Record payment & grant plan</button></form><script src="/js/admin-manual-entitlement.js" defer></script></section>`;
}
function insertBeforeMainEnd(html, section) {
    if (typeof html !== 'string' || !section) return html;
    const marker = '</main>';
    if (html.includes(marker)) return html.replace(marker, section + marker);
    const body = '</body>';
    return html.includes(body) ? html.replace(body, section + body) : html + section;
}
function hideEmptyManualEdit(html) {
    if (typeof html !== 'string') return html;
    const actionNeedle = '<input type="hidden" name="action" value="plan_change">';
    const labelNeedle = '>Manual entitlement edit</button>';
    const actionIndex = html.indexOf(actionNeedle);
    if (actionIndex < 0) return html;
    const labelIndex = html.indexOf(labelNeedle, actionIndex);
    if (labelIndex < 0) return html;
    const formStart = html.lastIndexOf('<form ', actionIndex);
    const formEnd = html.indexOf('</form>', labelIndex);
    if (formStart < 0 || formEnd < 0) return html;
    return html.slice(0, formStart) + html.slice(formEnd + '</form>'.length);
}
function normalizedGrantInput(body = {}) {
    const method = text(body.method, 20).toLowerCase();
    if (!METHODS.has(method)) throw new Error('Choose a valid payment or grant method.');
    const currency = text(body.currency, 3).toUpperCase();
    if (!CURRENCIES.has(currency)) throw new Error('Currency must be GBP, USD or EUR.');
    if (String(body.confirm || '') !== '1') throw new Error('Confirm that this action does not charge the provider.');
    const startAt = isoDate(body.startDate);
    const endAt = isoDate(body.endDate);
    if (endAt.getTime() <= startAt.getTime()) throw new Error('End date must be after the start date.');
    return {
        planId: text(body.planId, 80),
        serverId: text(body.serverId, 80) || null,
        method,
        currency,
        amountMinor: moneyMinor(body.amount),
        startAt,
        endAt,
        externalReference: text(body.externalReference, 255) || null,
        note: text(body.note, 500) || null,
        returnTab: body.returnTab === 'billing' ? 'billing' : 'access'
    };
}
async function createManualGrant(customerId, actorUserId, input) {
    const created = await transaction(async client => {
        const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
        if (!customer.rowCount) throw new Error('Customer not found.');
        const planResult = await client.query(`
            SELECT * FROM plans
            WHERE id=$1
              AND active=TRUE
              AND archived_at IS NULL
              AND (effective_from IS NULL OR effective_from<=NOW())
              AND (effective_until IS NULL OR effective_until>NOW())
              AND audience IN('direct','both')
              AND COALESCE(is_addon,FALSE)=FALSE
              AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio')
            LIMIT 1
        `, [input.planId]);
        if (!planResult.rowCount) throw new Error('Choose an active standalone direct-customer plan.');
        const plan = planResult.rows[0];
        const existing = await client.query(`
            SELECT s.id,p.name AS plan_name
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
            WHERE s.customer_id=$1 AND ${effectivePrimarySql()}
            FOR UPDATE OF s
            LIMIT 1
        `, [customerId]);
        if (existing.rowCount) throw new Error(`This customer already has a current primary subscription (${existing.rows[0].plan_name || 'active plan'}). Use Manual entitlement edit instead.`);
        const recognizedReference = recognizedProviderReference(input.method, input.externalReference);
        const status = plan.billing_interval === 'trial' ? 'trialing' : 'active';
        const sub = await manualSubscriptions.createManualSubscriptionTx(client, {
            customerId,
            planId: plan.id,
            startsAt: input.startAt,
            endsAt: input.endAt,
            actorUserId,
            source: 'admin_grant',
            status,
            auditAction: 'admin.customer.manual_grant',
            auditMetadata: {
                planCode: plan.code,
                planName: plan.name,
                serviceType: plan.service_type || 'jellyfin',
                startsAt: input.startAt.toISOString(),
                endsAt: input.endAt.toISOString(),
                amountMinor: input.amountMinor,
                currency: input.currency,
                method: input.method,
                externalReference: input.externalReference,
                recognizedProviderReference: recognizedReference,
                providerLinked: false,
                note: input.note,
                renewal: false,
                chargedProvider: false
            }
        });
        return { subscriptionId: sub.id, planName: plan.name };
    });
    if (input.serverId) {
        try {
            const assigned = await manualAssignment.assign(customerId, input.serverId, { actorUserId });
            return { ...created, reconciled: true, serverAssigned: true, serverName: assigned.server.name, capacityOverride: assigned.capacityOverride };
        } catch (error) {
            console.error('Manual grant server assignment failed:', { customerId, error: error.message });
            return { ...created, reconciled: false, serverAssigned: false, assignmentError: error.message };
        }
    }
    try {
        await provisioning.reconcileCustomer(customerId);
        return { ...created, reconciled: true, serverAssigned: false };
    } catch (error) {
        console.error('Manual customer entitlement reconciliation failed:', { customerId, error: error.message });
        return { ...created, reconciled: false, serverAssigned: false };
    }
}
function createAdminManualEntitlementRouter() {
    const router = express.Router();
    router.use('/admin/users', gate, noStore);

    // All /admin POSTs are already covered by adminMutationRateLimit in
    // admin-route-composition before this router is mounted.
    router.post('/admin/users/:customerId/manual-grant', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        let input;
        try {
            input = normalizedGrantInput(req.body || {});
            const result = await createManualGrant(req.params.customerId, req.session.authUserId, input);
            let message;
            if (result.serverAssigned) {
                message = `${result.planName} granted. Jellyfin access created on ${result.serverName}${result.capacityOverride ? ' (this server was already at or over its configured capacity — access was created anyway).' : '.'}`;
            } else if (input.serverId) {
                message = `${result.planName} granted, but Jellyfin access could not be created on the chosen server. ${String(result.assignmentError || 'Try Reconcile or a different server.').slice(0, 250)}`;
            } else if (result.reconciled) {
                message = `${result.planName} granted. Local access was reconciled; no provider charge or recurring link was created.`;
            } else {
                message = `${result.planName} granted. No provider charge or recurring link was created, but service reconciliation still needs attention.`;
            }
            return res.redirect(customerPath(req.params.customerId, input.returnTab, 'message', message));
        } catch (error) {
            console.error('Manual customer entitlement grant failed:', { customerId: req.params.customerId, error: error.message });
            const tab = input?.returnTab || (req.body?.returnTab === 'billing' ? 'billing' : 'access');
            return res.redirect(customerPath(req.params.customerId, tab, 'error', `Could not grant plan. ${String(error.message || 'Check the values and try again.').slice(0, 300)}`));
        }
    });

    router.use('/admin/users/:customerId', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const surface = req.query.tab === 'billing' ? 'billing' : req.query.tab === 'access' ? 'access' : (!req.query.tab || req.query.tab === 'overview') ? 'overview' : null;
        if (!surface) return next();
        try {
            const existing = await currentPrimarySubscription(req.params.customerId);
            const plans = !existing && surface !== 'overview' ? await grantPlans() : [];
            const serverMap = !existing && (surface === 'access' || surface === 'billing') ? await serversByPlan(plans) : new Map();
            const send = res.send.bind(res);
            res.send = body => {
                let html = body;
                if (!existing) {
                    html = hideEmptyManualEdit(html);
                    if (surface === 'access' || surface === 'billing') html = insertBeforeMainEnd(html, grantForm(req, req.params.customerId, plans, serverMap));
                }
                return send(html);
            };
            return next();
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = {
    METHODS,
    CURRENCIES,
    recognizedProviderReference,
    normalizedGrantInput,
    effectivePrimarySql,
    currentPrimarySubscription,
    grantForm,
    hideEmptyManualEdit,
    createManualGrant,
    createAdminManualEntitlementRouter
};
