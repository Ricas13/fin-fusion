'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const billing = require('../payments/billing-control');
const providerSettings = require('../payments/provider-settings');
const runtimeSettings = require('./runtime-settings');
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
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
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
        <td><strong>${esc(identity)}</strong><div class="subText">${esc(row.email || '')}</div></td>
        <td><strong>${esc(row.plan_name)}</strong><div class="subText">${esc(money(row))}</div></td>
        <td>${pill(providerLabel(row.source), row.source === 'stripe' ? 'accent' : '')}<div class="subText">${row.recurring ? 'Recurring' : 'One-time'}</div></td>
        <td>${statusPill(row.status)}${row.cancel_at_period_end ? `<div class="subText">Ends after current period</div>` : ''}</td>
        <td>${esc(date(row.current_period_end))}</td>
        <td>${remote}</td>
        <td>${syncState}</td>
        <td><code class="tinyCode">${esc(row.provider_subscription_id || '—')}</code></td>
        <td class="right">${subscriptionActions(req, row)}</td>
    </tr>`;
}

function eventRow(row) {
    const state = row.processed_at
        ? pill('Processed', 'good')
        : row.processing_error ? pill('Failed', 'bad') : pill('Pending');
    return `<tr><td>${esc(providerLabel(row.provider))}</td><td><code class="tinyCode">${esc(row.event_type)}</code></td><td>${state}</td><td>${esc(date(row.created_at))}</td><td>${row.processing_error ? `<span class="errorText">${esc(row.processing_error)}</span>` : '—'}</td></tr>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [data, stripeStatus, paypalStatus] = await Promise.all([
        billing.dashboardData(),
        providerSettings.status('stripe'),
        providerSettings.status('paypal')
    ]);
    const cards = [
        ['Recurring subscriptions', data.stats.recurring],
        ['Active', data.stats.active],
        ['Past due', data.stats.pastDue],
        ['Ending / cancelled renewal', data.stats.cancelling],
        ['Sync problems', data.stats.syncProblems]
    ];
    const providerState = `${stripeStatus.configured ? pill('Stripe ready', 'good') : pill('Stripe not ready', stripeStatus.enabled ? 'warn' : '')} ${paypalStatus.configured ? pill('PayPal ready', 'good') : pill('PayPal not ready', paypalStatus.enabled ? 'warn' : '')}`;
    const body = `${notice(req)}
        <div class="metrics">${cards.map(([label,value]) => `<div class="metric"><div class="metricLabel">${esc(label)}</div><div class="metricValue smallish">${Number(value).toLocaleString('en-GB')}</div></div>`).join('')}</div>
        <section class="section"><div class="sectionHead"><div><h2>Provider reconciliation</h2><div class="muted">Periodically verifies recurring subscriptions against Stripe and PayPal so missed or delayed webhooks are not the only source of truth.</div></div><div>${providerState}</div></div>
            <div class="billingToolbar"><form method="post" action="/admin/billing/sync-due">${csrfInput(req)}<button class="button secondary" type="submit">Sync due subscriptions</button></form><form method="post" action="/admin/billing/sync-all" data-confirm="Sync every active recurring subscription against the payment providers now?">${csrfInput(req)}<button class="button" type="submit">Sync all now</button></form><a class="button secondary" href="/admin/payments">Gateway settings</a></div>
            <div class="notice">Provider API/network failures never revoke customer access by themselves. A failed verification is recorded here with backoff and the existing subscription state is preserved until an authoritative provider state is obtained.</div>
            ${data.subscriptions.length ? `<div class="tableWrap"><table class="dataTable billingTable"><thead><tr><th>Customer</th><th>Plan</th><th>Provider</th><th>Local state</th><th>Paid through</th><th>Provider state</th><th>Sync</th><th>Provider ID</th><th class="right">Actions</th></tr></thead><tbody>${data.subscriptions.map(row => subscriptionRow(req,row)).join('')}</tbody></table></div>` : '<div class="empty">No Stripe or PayPal subscriptions have been recorded yet.</div>'}
        </section>
        <section class="section"><div class="sectionHead"><div><h2>Recent provider events</h2><div class="muted">Latest Stripe/PayPal webhook processing results.</div></div><span class="muted">${data.events.length} shown</span></div>${data.events.length ? `<div class="tableWrap"><table class="dataTable eventTable"><thead><tr><th>Provider</th><th>Event</th><th>Status</th><th>Received</th><th>Error</th></tr></thead><tbody>${data.events.map(eventRow).join('')}</tbody></table></div>` : '<div class="empty">No provider events yet.</div>'}</section>
        <style>.billingTable{min-width:1420px}.eventTable{min-width:850px}.billingToolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.billingToolbar form,.billingActions form{margin:0}.billingActions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.tinyCode{font-size:10px;white-space:nowrap}.errorText{color:#ef9298;max-width:340px;display:inline-block}.metricValue.smallish{font-size:22px}</style>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'billing', title: 'Billing', subtitle: 'Recurring subscription lifecycle, provider reconciliation and webhook health', body });
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

module.exports = { createAdminBillingRouter, page };
