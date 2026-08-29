'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const provisioning = require('../jellyfin/provisioning');

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
function providerSubscriptionId(method, externalReference) {
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
async function grantPlans() {
    const result = await query(`
        SELECT id,code,name,service_type,billing_interval,duration_days,price_minor,currency
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
async function currentPrimarySubscription(customerId) {
    const result = await query(`
        SELECT s.id,s.status,s.current_period_end,p.name AS plan_name
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        WHERE s.customer_id=$1
          AND s.superseded_by IS NULL
          AND COALESCE(p.is_addon,FALSE)=FALSE
          AND s.starts_at<=NOW()
          AND s.status IN('active','trialing','past_due','paused')
          AND s.current_period_end>NOW()
        ORDER BY s.created_at DESC
        LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}
function grantForm(req, customerId, plans) {
    if (!plans.length) return '<div class="operatorCallout warn"><strong>No grantable direct-customer plans are currently active.</strong></div>';
    const start = today();
    const first = plans[0];
    const end = addDays(start, Number(first.duration_days || 30));
    const options = plans.map(plan => `<option value="${esc(plan.id)}" data-days="${esc(plan.duration_days || 30)}" data-amount="${esc((Number(plan.price_minor || 0) / 100).toFixed(2))}" data-currency="${esc(plan.currency || 'GBP')}">${esc(plan.name)} · ${esc(String(plan.service_type || 'jellyfin').replace(/^./, c => c.toUpperCase()))}</option>`).join('');
    return `<section class="section" id="manual-entitlement-grant"><div class="sectionHead"><div><h2>Record off-platform payment / grant plan</h2><div class="muted">Create local access for a customer who has no current primary subscription. This records the administrator action only; it does not create a provider checkout or webhook.</div></div><span class="pill warn">Manual grant</span></div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manual-grant" data-native-submit="true"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="returnTab" value="${esc(req.query.tab === 'billing' ? 'billing' : 'access')}"><div class="formGrid"><div class="formGroup"><label>Plan</label><select class="input" name="planId" id="manualGrantPlan" required>${options}</select></div><div class="formGroup"><label>Payment / grant method</label><select class="input" name="method" required><option value="paypal">PayPal</option><option value="stripe">Stripe</option><option value="bank">Bank transfer</option><option value="other">Other / complimentary</option></select></div><div class="formGroup"><label>Start date</label><input class="input" type="date" name="startDate" id="manualGrantStart" value="${esc(start)}" required></div><div class="formGroup"><label>End date</label><input class="input" type="date" name="endDate" id="manualGrantEnd" value="${esc(end)}" required><div class="inlineHelp">Defaults to the selected plan duration. You can override it before saving.</div></div><div class="formGroup"><label>Amount recorded</label><input class="input" name="amount" id="manualGrantAmount" inputmode="decimal" value="${esc((Number(first.price_minor || 0) / 100).toFixed(2))}" required></div><div class="formGroup"><label>Currency</label><select class="input" name="currency" id="manualGrantCurrency"><option value="GBP" ${first.currency === 'GBP' ? 'selected' : ''}>GBP</option><option value="USD" ${first.currency === 'USD' ? 'selected' : ''}>USD</option><option value="EUR" ${first.currency === 'EUR' ? 'selected' : ''}>EUR</option></select></div><div class="formGroup"><label>External reference</label><input class="input" name="externalReference" maxlength="255" placeholder="PayPal transaction / I-… or Stripe reference / sub_…"><div class="inlineHelp">Stored in the audit record. A provider subscription ID is only attached to the local subscription when it actually matches PayPal <code>I-…</code> or Stripe <code>sub_…</code> format.</div></div><div class="formGroup"><label>Admin note</label><input class="input" name="note" maxlength="500" placeholder="Why this access was granted"></div></div><label class="securityNote standalone"><input type="checkbox" name="confirm" value="1" required> I understand this records local access/payment information only and <strong>does not charge the provider</strong>. Automatic renewal remains off.</label><button class="button" type="submit">Record payment & grant plan</button></form><script>(function(){const p=document.getElementById('manualGrantPlan'),s=document.getElementById('manualGrantStart'),e=document.getElementById('manualGrantEnd'),a=document.getElementById('manualGrantAmount'),c=document.getElementById('manualGrantCurrency');if(!p||!s||!e)return;function plus(dateText,days){const d=new Date(dateText+'T00:00:00Z');if(Number.isNaN(d.getTime()))return '';d.setUTCDate(d.getUTCDate()+Number(days||30));return d.toISOString().slice(0,10)}function sync(resetCommercial){const o=p.options[p.selectedIndex];if(!o)return;e.value=plus(s.value,o.dataset.days);if(resetCommercial){a.value=o.dataset.amount||'0.00';c.value=o.dataset.currency||'GBP'}}p.addEventListener('change',()=>sync(true));s.addEventListener('change',()=>sync(false));})();</script></section>`;
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
    const form = /<form class="plainForm" method="post" action="\/admin\/customers\/bulk\/preview">[\s\S]*?<input type="hidden" name="action" value="plan_change">[\s\S]*?<button class="button secondary" type="submit">Manual entitlement edit<\/button><\/form>/;
    return html.replace(form, '');
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
            WHERE s.customer_id=$1
              AND s.superseded_by IS NULL
              AND COALESCE(p.is_addon,FALSE)=FALSE
              AND s.starts_at<=NOW()
              AND s.status IN('active','trialing','past_due','paused')
              AND s.current_period_end>NOW()
            FOR UPDATE OF s
            LIMIT 1
        `, [customerId]);
        if (existing.rowCount) throw new Error(`This customer already has a current primary subscription (${existing.rows[0].plan_name || 'active plan'}). Use Manual entitlement edit instead.`);
        const providerId = providerSubscriptionId(input.method, input.externalReference);
        const status = plan.billing_interval === 'trial' ? 'trialing' : 'active';
        const sub = await client.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,provider_subscription_id)
            VALUES($1,$2,$3,'admin_grant',$4,$5,TRUE,$6)
            RETURNING id
        `, [customerId, plan.id, status, input.startAt, input.endAt, providerId]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.manual_grant','customer',$2,$3::jsonb)
        `, [actorUserId, customerId, JSON.stringify({
            subscriptionId: sub.rows[0].id,
            planId: plan.id,
            planCode: plan.code,
            planName: plan.name,
            serviceType: plan.service_type || 'jellyfin',
            startsAt: input.startAt.toISOString(),
            endsAt: input.endAt.toISOString(),
            amountMinor: input.amountMinor,
            currency: input.currency,
            method: input.method,
            externalReference: input.externalReference,
            providerSubscriptionId: providerId,
            note: input.note,
            renewal: false,
            chargedProvider: false
        })]);
        return { subscriptionId: sub.rows[0].id, planName: plan.name };
    });
    await provisioning.reconcileCustomer(customerId);
    return created;
}
function createAdminManualEntitlementRouter() {
    const router = express.Router();
    router.use('/admin/users', gate, noStore);

    router.post('/admin/users/:customerId/manual-grant', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        let input;
        try {
            input = normalizedGrantInput(req.body || {});
            const result = await createManualGrant(req.params.customerId, req.session.authUserId, input);
            return res.redirect(customerPath(req.params.customerId, input.returnTab, 'message', `${result.planName} granted. Local access was reconciled; no provider charge was created and renewal remains off.`));
        } catch (error) {
            console.error('Manual customer entitlement grant failed:', { customerId: req.params.customerId, error: error.message });
            const tab = input?.returnTab || (req.body?.returnTab === 'billing' ? 'billing' : 'access');
            return res.redirect(customerPath(req.params.customerId, tab, 'error', `Could not grant plan. ${String(error.message || 'Check the values and try again.').slice(0, 300)}`));
        }
    });

    router.use('/admin/users/:customerId', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const tab = req.query.tab === 'billing' ? 'billing' : req.query.tab === 'access' ? 'access' : null;
        if (!tab) return next();
        try {
            const [existing, plans] = await Promise.all([currentPrimarySubscription(req.params.customerId), grantPlans()]);
            const send = res.send.bind(res);
            res.send = body => {
                let html = body;
                if (!existing) {
                    html = hideEmptyManualEdit(html);
                    html = insertBeforeMainEnd(html, grantForm(req, req.params.customerId, plans));
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
    providerSubscriptionId,
    normalizedGrantInput,
    currentPrimarySubscription,
    grantForm,
    hideEmptyManualEdit,
    createManualGrant,
    createAdminManualEntitlementRouter
};
