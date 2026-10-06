'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const manualEntitlement = require('../entitlements/admin-manual-entitlement-service');

const { METHODS, CURRENCIES } = manualEntitlement;

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
const recognizedProviderReference = manualEntitlement.recognizedProviderReference;
const normalizedGrantInput = manualEntitlement.normalizedGrantInput;
const currentPrimarySubscription = manualEntitlement.currentPrimarySubscription;
const grantPlans = manualEntitlement.grantPlans;
const grantablePlansForCustomer = manualEntitlement.grantablePlansForCustomer;
const createManualGrant = manualEntitlement.createManualGrant;
const isoDate = manualEntitlement.isoDate;
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
function grantForm(req, customerId, plans) {
    if (!plans.length) return '<div class="operatorCallout warn"><strong>No grantable direct-customer plans are currently active.</strong></div>';
    const start = today();
    const first = plans[0];
    const end = addDays(start, Number(first.duration_days || 30));
    const options = plans.map(plan => `<option value="${esc(plan.id)}" data-days="${esc(plan.duration_days || 30)}" data-amount="${esc((Number(plan.price_minor || 0) / 100).toFixed(2))}" data-currency="${esc(plan.currency || 'GBP')}">${esc(plan.name)} · ${esc(String(plan.service_type || 'jellyfin').replace(/^./, c => c.toUpperCase()))}</option>`).join('');
    return `<section class="section" id="manual-entitlement-grant"><div class="sectionHead"><div><h2>Record off-platform payment / grant plan</h2><div class="muted">Create local access for a customer who has no current primary subscription. This records the administrator action only; it does not create a provider checkout, webhook or recurring-provider link.</div></div><span class="pill warn">Manual grant</span></div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manual-grant" data-native-submit="true"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="returnTab" value="${esc(req.query.tab === 'billing' ? 'billing' : 'access')}"><div class="formGrid"><div class="formGroup"><label>Plan</label><select class="input" name="planId" id="manualGrantPlan" required>${options}</select></div><div class="formGroup"><label>Payment / grant method</label><select class="input" name="method" required><option value="paypal">PayPal</option><option value="stripe">Stripe</option><option value="bank">Bank transfer</option><option value="other">Other / complimentary</option></select></div><div class="formGroup"><label>Start date</label><input class="input" type="date" name="startDate" id="manualGrantStart" value="${esc(start)}" required></div><div class="formGroup"><label>End date</label><input class="input" type="date" name="endDate" id="manualGrantEnd" value="${esc(end)}" required><div class="inlineHelp">Defaults to the selected plan duration. You can override it before saving.</div></div><div class="formGroup"><label>Amount recorded</label><input class="input" name="amount" id="manualGrantAmount" inputmode="decimal" value="${esc((Number(first.price_minor || 0) / 100).toFixed(2))}" required></div><div class="formGroup"><label>Currency</label><select class="input" name="currency" id="manualGrantCurrency"><option value="GBP" ${first.currency === 'GBP' ? 'selected' : ''}>GBP</option><option value="USD" ${first.currency === 'USD' ? 'selected' : ''}>USD</option><option value="EUR" ${first.currency === 'EUR' ? 'selected' : ''}>EUR</option></select></div><div class="formGroup"><label>External reference</label><input class="input" name="externalReference" maxlength="255" placeholder="PayPal transaction / I-… or Stripe reference / sub_…"><div class="inlineHelp">Stored in the audit record only. Even a PayPal <code>I-…</code> or Stripe <code>sub_…</code> reference does not convert this manual grant into a provider-managed recurring subscription.</div></div><div class="formGroup"><label>Admin note</label><input class="input" name="note" maxlength="500" placeholder="Why this access was granted"></div></div><label class="securityNote standalone"><input type="checkbox" name="confirm" value="1" required> I understand this records local access/payment information only and <strong>does not charge the provider</strong>. Automatic renewal remains off.</label><button class="button" type="submit">Record payment & grant plan</button></form><script src="/js/admin-manual-entitlement.js" defer></script></section>`;
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
            const message = result.reconciled
                ? `${result.planName} granted. Local access was reconciled; no provider charge or recurring link was created.`
                : `${result.planName} granted. No provider charge or recurring link was created, but service reconciliation still needs attention.`;
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
            const plans = surface !== 'overview' ? await grantablePlansForCustomer(req.params.customerId) : [];
            const send = res.send.bind(res);
            res.send = body => {
                let html = body;
                if (!existing) html = hideEmptyManualEdit(html);
                // Independent service lanes are allowed: for example a customer
                // with Stremio may still receive a Jellyfin manual grant. Render
                // only plans whose capabilities do not overlap current access.
                // The compact empty-account form still wins when present so the
                // page never carries duplicate form IDs.
                if ((surface === 'access' || surface === 'billing') && plans.length && !html.includes('manualGrantCompact')) {
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
    recognizedProviderReference,
    normalizedGrantInput,
    currentPrimarySubscription,
    grantForm,
    grantablePlansForCustomer,
    hideEmptyManualEdit,
    createManualGrant,
    createAdminManualEntitlementRouter
};
