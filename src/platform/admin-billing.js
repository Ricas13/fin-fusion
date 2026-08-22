'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const billing = require('../payments/billing-control');
const providerSettings = require('../payments/provider-settings');
const runtimeSettings = require('./runtime-settings');
const ui = require('./admin-ui');
const { esc, layout } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function date(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function pill(label, cls = '') { return `<span class="pill ${cls}">${esc(label)}</span>`; }
function statusPill(status) {
    const value = String(status || 'unknown');
    if (['active','trialing'].includes(value)) return pill(value, 'good');
    if (value === 'past_due') return pill('past due', 'warn');
    if (['cancelled','expired'].includes(value)) return pill(value, 'bad');
    if (value === 'paused') return pill(value, 'warn');
    return pill(value);
}
function money(row) {
    if (!Number.isFinite(Number(row.price_minor))) return '—';
    return `${String(row.currency || 'USD').toUpperCase()} ${(Number(row.price_minor) / 100).toFixed(2)}`;
}
function providerLabel(value) { return value === 'stripe' ? 'Stripe' : value === 'paypal' ? 'PayPal' : value; }

function subscriptionActions(req, row) {
    if (!row.recurring) return '<span class="muted">One-time purchase</span>';
    const buttons = [`<form method="post" action="/admin/billing/${esc(row.id)}/sync">${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Sync now</button></form>`];
    if (['active','trialing','past_due','paused'].includes(row.status)) {
        if (!row.cancel_at_period_end) {
            buttons.push(`<form method="post" action="/admin/billing/${esc(row.id)}/stop-renewal" data-confirm="Stop automatic renewal? Access remains until the paid-through date.">${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Stop renewal</button></form>`);
        } else if (row.source === 'stripe') {
            buttons.push(`<form method="post" action="/admin/billing/${esc(row.id)}/resume-renewal">${csrfInput(req)}<button class="button btn-sm" type="submit">Resume renewal</button></form>`);
        }
    }
    return `<div class="billingActions">${buttons.join('')}</div>`;
}

function subscriptionRow(req, row) {
    const identity = row.portal_username || row.display_name || row.email || 'Customer';
    const remote = row.remote_status
        ? `${esc(row.remote_status)}${row.last_success_at ? `<div class="subText">Synced ${esc(date(row.last_success_at))}</div>` : ''}`
        : '<span class="muted">Not synced yet</span>';
    const syncState = row.last_error
        ? `<span class="pill bad">Sync error</span><div class="subText errorText">${esc(row.last_error)}</div><div class="subText">Retry ${esc(date(row.next_attempt_at))}</div>`
        : row.last_success_at
            ? `<span class="pill good">Healthy</span><div class="subText">Next ${esc(date(row.next_attempt_at))}</div>`
            : row.recurring ? `<span class="pill">Pending</span>` : '<span class="muted">Not applicable</span>';
    return `<tr>
        <td><a href="/admin/users/${esc(row.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(row.email || '')}</div></td>
        <td><strong>${esc(row.plan_name)}</strong><div class="subText">${esc(money(row))}</div></td>
        <td>${pill(providerLabel(row.source), row.source === 'stripe' ? 'accent' : '')}<div class="subText">${row.recurring ? 'Recurring' : 'One-time'}</div></td>
        <td>${statusPill(row.status)}${row.cancel_at_period_end ? `<div class="subText">Ends after current period</div>` : ''}</td>
        <td>${esc(date(row.current_period_end))}</td>
        <td>${remote}</td>
        <td>${syncState}</td>
        <td class="right">${subscriptionActions(req, row)}</td>
    </tr>`;
}
function subscriptionTable(req, rows) {
    if (!rows.length) return '<div class="empty">No matching recurring subscriptions.</div>';
    return `<div class="tableWrap"><table class="dataTable billingTable"><thead><tr><th>Customer</th><th>Plan</th><th>Provider</th><th>Billing state</th><th>Paid through</th><th>Provider state</th><th>Sync</th><th class="right">Actions</th></tr></thead><tbody>${rows.map(row => subscriptionRow(req,row)).join('')}</tbody></table></div>`;
}
function eventRow(row) {
    const state = row.processed_at
        ? pill('Processed', 'good')
        : row.processing_error ? pill('Failed', 'bad') : pill('Pending');
    return `<tr><td>${esc(providerLabel(row.provider))}</td><td><code class="tinyCode">${esc(row.event_type)}</code></td><td>${state}</td><td>${esc(date(row.created_at))}</td><td>${row.processing_error ? `<span class="errorText">${esc(row.processing_error)}</span>` : '—'}</td></tr>`;
}
function billingHero(data,stripeStatus,paypalStatus){
    const problems=data.subscriptions.filter(row=>row.status==='past_due'||Boolean(row.last_error)),pastDue=problems.filter(row=>row.status==='past_due').length,syncProblems=problems.filter(row=>row.last_error).length,providerProblem=(stripeStatus.enabled&&!stripeStatus.configured)||(paypalStatus.enabled&&!paypalStatus.configured);
    const tone=problems.length?'bad':providerProblem?'warn':'commerce';
    const title=problems.length?`${problems.length} recurring ${problems.length===1?'subscription needs':'subscriptions need'} attention`:providerProblem?'A payment provider needs configuration':'Recurring billing is clear';
    const next=problems[0]?`Open ${problems[0].portal_username||problems[0].display_name||problems[0].email||'the first customer'} and synchronize the provider state before changing renewal.`:providerProblem?'Finish the enabled provider configuration in Payments.':'No billing intervention is required; use Sync due for routine reconciliation.';
    return ui.operatorHero({tone,eyebrow:'Billing operations',title,body:'Billing is the exception desk for recurring subscriptions. Customer-impacting problems appear before routine reconciliation and raw provider history.',statusLabel:problems.length?'Action required':providerProblem?'Setup incomplete':'Billing healthy',next,facts:[{label:'Recurring',value:String(data.stats.recurring),detail:'provider-managed subscriptions'},{label:'Past due',value:String(pastDue),detail:'customer payment attention'},{label:'Sync problems',value:String(syncProblems),detail:'provider verification errors'},{label:'Ending renewal',value:String(data.stats.cancelling),detail:'scheduled to stop'}],actionsHtml:problems[0]?`<a class="button" href="/admin/users/${encodeURIComponent(problems[0].customer_id)}?tab=billing">Open first affected customer</a><a class="button secondary" href="#billing-problems">Billing problems</a>`:'<a class="button secondary" href="#billing-reconcile">Reconcile due</a><a class="button secondary" href="/admin/payments">Payment providers</a>'});
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [data, stripeStatus, paypalStatus] = await Promise.all([
        billing.dashboardData(),
        providerSettings.status('stripe'),
        providerSettings.status('paypal')
    ]);
    const problems=data.subscriptions.filter(row=>row.status==='past_due'||Boolean(row.last_error));
    const failedEvents=data.events.filter(row=>row.processing_error&&!row.processed_at);
    const providerState = `${stripeStatus.configured ? pill('Stripe ready', 'good') : pill('Stripe not ready', stripeStatus.enabled ? 'warn' : '')} ${paypalStatus.configured ? pill('PayPal ready', 'good') : pill('PayPal not ready', paypalStatus.enabled ? 'warn' : '')}`;
    const problemSection=problems.length?`<section class="section" id="billing-problems">${ui.sectionHeader({title:'Fix these subscriptions first',description:'Past-due customers and provider-sync failures. Open the customer journey for context, or sync the subscription directly.'})}${subscriptionTable(req,problems)}</section>`:'';
    const reconciliation=`<section class="section" id="billing-reconcile"><div class="sectionHead"><div><h2>Provider reconciliation</h2><div class="muted">Verifies recurring subscriptions against Stripe and PayPal so webhooks are not the only source of truth.</div></div><div>${providerState}</div></div><div class="billingToolbar"><form method="post" action="/admin/billing/sync-due">${csrfInput(req)}<button class="button secondary" type="submit">Sync due subscriptions</button></form><form method="post" action="/admin/billing/sync-all" data-confirm="Sync every active recurring subscription against the payment providers now?">${csrfInput(req)}<button class="button" type="submit">Sync all now</button></form><a class="button secondary" href="/admin/payments">Gateway settings</a></div><div class="notice">Provider API/network failures never revoke customer access by themselves. Existing subscription state is preserved until authoritative provider state is obtained.</div></section>`;
    const allSubscriptions=ui.detailDisclosure({title:`All recurring subscriptions (${data.subscriptions.length})`,summary:'Routine subscription state · open when tracing or changing a specific renewal',bodyHtml:subscriptionTable(req,data.subscriptions)});
    const eventSummary=failedEvents.length?`<div class="operatorCallout warn"><strong>${failedEvents.length} recent provider ${failedEvents.length===1?'event has':'events have'} a processing error.</strong><span> Resolve customer-facing effects in Commerce; use the event history below for provider diagnosis.</span></div>`:'';
    const events=ui.detailDisclosure({title:`Recent provider events (${data.events.length})`,summary:failedEvents.length?`${failedEvents.length} failed · diagnostic webhook history`:'Diagnostic webhook history',bodyHtml:data.events.length?`<div class="tableWrap"><table class="dataTable eventTable"><thead><tr><th>Provider</th><th>Event</th><th>Status</th><th>Received</th><th>Error</th></tr></thead><tbody>${data.events.map(eventRow).join('')}</tbody></table></div>`:'<div class="empty">No provider events yet.</div>'});
    const body = `${ui.noticesFromRequest(req)}${billingHero(data,stripeStatus,paypalStatus)}${problemSection}${reconciliation}${eventSummary}${allSubscriptions}${events}<style>.billingTable{min-width:1240px}.eventTable{min-width:850px}.billingToolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.billingToolbar form,.billingActions form{margin:0}.billingActions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.tinyCode{font-size:10px;white-space:nowrap}.errorText{color:#ef9298;max-width:340px;display:inline-block}</style>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'billing', title: 'Billing', subtitle: 'Customer-impacting recurring billing problems first; provider diagnostics second', body });
}

function createAdminBillingRouter() {
    const router = express.Router();
    router.use('/admin/billing', gate, noStore);
    router.get('/admin/billing', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/billing/sync-due', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await billing.syncDue({ all: false, limit: 100 });
            return res.redirect(`/admin/billing?message=${encodeURIComponent(`Provider sync complete: ${result.succeeded} succeeded, ${result.failed} failed.`)}`);
        } catch (error) {
            return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Provider sync failed.'));
        }
    });
    router.post('/admin/billing/sync-all', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await billing.syncDue({ all: true, limit: 500 });
            return res.redirect(`/admin/billing?message=${encodeURIComponent(`Full provider sync complete: ${result.succeeded} succeeded, ${result.failed} failed.`)}`);
        } catch (error) {
            return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Provider sync failed.'));
        }
    });
    router.post('/admin/billing/:id/sync', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await billing.syncSubscription(req.params.id);
            if (!result.ok) throw new Error(result.error);
            return res.redirect('/admin/billing?message=' + encodeURIComponent('Subscription synchronized with the payment provider.'));
        } catch (error) {
            return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Subscription could not be synchronized.'));
        }
    });
    router.post('/admin/billing/:id/stop-renewal', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await billing.setRenewal(req.params.id, false, req.session.authUserId);
            return res.redirect('/admin/billing?message=' + encodeURIComponent('Automatic renewal stopped. Existing paid access remains until the paid-through date.'));
        } catch (error) {
            return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Renewal could not be stopped.'));
        }
    });
    router.post('/admin/billing/:id/resume-renewal', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await billing.setRenewal(req.params.id, true, req.session.authUserId);
            return res.redirect('/admin/billing?message=' + encodeURIComponent('Automatic renewal restored.'));
        } catch (error) {
            return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Renewal could not be restored.'));
        }
    });
    return router;
}

module.exports = { createAdminBillingRouter, page, billingHero, subscriptionTable, subscriptionRow };
