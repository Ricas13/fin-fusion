'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const billing = require('../payments/billing-control');
const discovery = require('../payments/subscription-discovery');
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
    const value = String(status || 'unknown').toLowerCase();
    if (['active','trialing'].includes(value)) return pill(value, 'good');
    if (['past_due','unpaid','suspended'].includes(value)) return pill(value.replace('_',' '), 'warn');
    if (['cancelled','canceled','expired'].includes(value)) return pill(value, 'bad');
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
        if (!row.cancel_at_period_end) buttons.push(`<form method="post" action="/admin/billing/${esc(row.id)}/stop-renewal" data-confirm="Stop automatic renewal? Access remains until the paid-through date.">${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Stop renewal</button></form>`);
        else if (row.source === 'stripe') buttons.push(`<form method="post" action="/admin/billing/${esc(row.id)}/resume-renewal">${csrfInput(req)}<button class="button btn-sm" type="submit">Resume renewal</button></form>`);
    }
    return `<div class="billingActions">${buttons.join('')}</div>`;
}
function subscriptionRow(req, row) {
    const identity = row.portal_username || row.display_name || row.email || 'Customer';
    const remote = row.remote_status ? `${esc(row.remote_status)}${row.last_success_at ? `<div class="subText">Synced ${esc(date(row.last_success_at))}</div>` : ''}` : '<span class="muted">Not synced yet</span>';
    const syncState = row.last_error ? `<span class="pill bad">Sync error</span><div class="subText errorText">${esc(row.last_error)}</div><div class="subText">Retry ${esc(date(row.next_attempt_at))}</div>` : row.last_success_at ? `<span class="pill good">Healthy</span><div class="subText">Next ${esc(date(row.next_attempt_at))}</div>` : row.recurring ? `<span class="pill">Pending</span>` : '<span class="muted">Not applicable</span>';
    return `<tr>
        <td data-label="Customer"><a href="/admin/users/${esc(row.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(row.email || '')}</div></td>
        <td data-label="Plan"><strong>${esc(row.plan_name)}</strong><div class="subText">${esc(money(row))}</div></td>
        <td data-label="Provider">${pill(providerLabel(row.source), row.source === 'stripe' ? 'accent' : '')}<div class="subText">${row.recurring ? 'Recurring' : 'One-time'}</div></td>
        <td data-label="Billing state">${statusPill(row.status)}${row.cancel_at_period_end ? `<div class="subText">Ends after current period</div>` : ''}</td>
        <td data-label="Paid through">${esc(date(row.current_period_end))}</td><td data-label="Provider state">${remote}</td><td data-label="Sync">${syncState}</td><td data-label="Actions" class="right">${subscriptionActions(req, row)}</td>
    </tr>`;
}
function subscriptionTable(req, rows) {
    if (!rows.length) return '<div class="empty">No matching recurring subscriptions.</div>';
    return `<div class="tableWrap"><table class="dataTable responsiveTable billingTable"><thead><tr><th>Customer</th><th>Plan</th><th>Provider</th><th>Billing state</th><th>Paid through</th><th>Provider state</th><th>Sync</th><th class="right">Actions</th></tr></thead><tbody>${rows.map(row => subscriptionRow(req,row)).join('')}</tbody></table></div>`;
}
function eventRow(row) {
    const state = row.processed_at ? pill('Processed', 'good') : row.processing_error ? pill('Failed', 'bad') : pill('Pending');
    return `<tr><td data-label="Provider">${esc(providerLabel(row.provider))}</td><td data-label="Event"><code class="tinyCode">${esc(row.event_type)}</code></td><td data-label="Status">${state}</td><td data-label="Received">${esc(date(row.created_at))}</td><td data-label="Error">${row.processing_error ? `<span class="errorText">${esc(row.processing_error)}</span>` : '—'}</td></tr>`;
}
function recurringProblems(data){return data.subscriptions.filter(row=>row.recurring&&(row.status==='past_due'||Boolean(row.last_error)));}

function billingHero(data, stripeStatus, paypalStatus, coverage = { premium: 0, linked: 0, missing: 0 }) {
    const problems=recurringProblems(data),pastDue=problems.filter(row=>row.status==='past_due').length,syncProblems=problems.filter(row=>row.last_error).length,providerProblem=(stripeStatus.enabled&&!stripeStatus.configured)||(paypalStatus.enabled&&!paypalStatus.configured),missing=Number(coverage.missing||0);
    const tone=problems.length?'bad':missing?'warn':providerProblem?'warn':'commerce';
    const title=problems.length?`${problems.length} recurring ${problems.length===1?'subscription needs':'subscriptions need'} attention`:missing?`${missing} premium ${missing===1?'user is':'users are'} missing a provider subscription`:providerProblem?'A payment provider needs configuration':'Recurring billing is clear';
    const next=problems[0]?`Open ${problems[0].portal_username||problems[0].display_name||problems[0].email||'the first customer'} and synchronize the provider state before changing renewal.`:missing?'Run current subscription discovery below. Safe customer + plan matches can be attached without creating a second entitlement.':providerProblem?'Finish the enabled provider configuration in Payments.':'No billing intervention is required; use Sync due for routine reconciliation.';
    return ui.operatorHero({tone,eyebrow:'Billing operations',title,body:'Every active paid Premium Server entitlement should resolve to a current provider subscription. Provider discovery links existing premium users; ordinary reconciliation then keeps provider state current.',statusLabel:problems.length?'Action required':missing?'Missing billing links':providerProblem?'Setup incomplete':'Billing healthy',next,facts:[{label:'Premium users',value:String(coverage.premium||0),detail:'active paid Premium Server entitlements'},{label:'Provider linked',value:String(coverage.linked||0),detail:'premium users with recurring billing IDs'},{label:'Missing link',value:String(missing),detail:'premium users requiring discovery'},{label:'Past due',value:String(pastDue),detail:'customer payment attention'}],actionsHtml:problems[0]?`<a class="button" href="/admin/users/${encodeURIComponent(problems[0].customer_id)}?tab=billing">Open first affected customer</a><a class="button secondary" href="#billing-problems">Billing problems</a>`:missing?'<a class="button" href="#billing-discovery">Discover subscriptions</a><a class="button secondary" href="#billing-reconcile">Provider reconciliation</a>':'<a class="button secondary" href="#billing-reconcile">Reconcile due</a><a class="button secondary" href="/admin/payments">Payment providers</a>'});
}

function discoveryStatePill(state) {
    if (state === 'safe') return pill('Safe match', 'good');
    if (state === 'linked') return pill('Already linked', 'good');
    if (state === 'ambiguous') return pill('Ambiguous', 'warn');
    if (state === 'conflict') return pill('Conflict', 'bad');
    return pill('Unresolved', 'warn');
}
function discoveryRow(item) {
    const local = item.local || {}, remote = item.match;
    const identity = local.portal_username || local.display_name || local.email || 'Customer';
    const provider = remote ? `${providerLabel(remote.provider)}<div class="subText"><code class="tinyCode">${esc(remote.id)}</code></div>` : '—';
    const providerState = remote ? `${statusPill(remote.status)}<div class="subText">${esc(date(remote.periodEnd))}</div>` : '—';
    return `<tr><td data-label="Premium user"><a href="/admin/users/${encodeURIComponent(local.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(local.email||'')}</div></td><td data-label="Local plan"><strong>${esc(local.plan_name||local.plan_code||'Premium')}</strong><div class="subText">${esc(local.plan_code||'')}</div></td><td data-label="Provider subscription">${provider}</td><td data-label="Provider state">${providerState}</td><td data-label="Match">${discoveryStatePill(item.state)}</td><td data-label="Reason">${esc(item.reason||'')}</td></tr>`;
}
function discoverySection(req, coverage, result = null, error = null) {
    const warning = error ? `<div class="operatorCallout bad"><strong>Discovery stopped:</strong> ${esc(error)}</div>` : '';
    const summary = result ? `<div class="metrics"><div class="metric"><div class="metricLabel">Premium users</div><div class="metricValue">${esc(result.counts.premium)}</div></div><div class="metric"><div class="metricLabel">Already linked</div><div class="metricValue">${esc(result.counts.linked)}</div></div><div class="metric"><div class="metricLabel">Safe matches</div><div class="metricValue">${esc(result.counts.safe)}</div></div><div class="metric"><div class="metricLabel">Needs review</div><div class="metricValue">${esc(result.counts.ambiguous+result.counts.conflict+result.counts.unresolved)}</div></div></div>` : '';
    const warnings = (result?.warnings||[]).map(text=>`<div class="operatorCallout warn">${esc(text)}</div>`).join('');
    const tableRows = result?.rows || [];
    const table = tableRows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable discoveryTable"><thead><tr><th>Premium user</th><th>Local plan</th><th>Provider subscription</th><th>Provider state</th><th>Match</th><th>Reason</th></tr></thead><tbody>${tableRows.map(discoveryRow).join('')}</tbody></table></div>` : result ? '<div class="empty">No active paid Premium Server users were found.</div>' : '';
    const apply = result?.counts.safe ? `<form method="post" action="/admin/billing/discover/apply" class="formPanel discoveryApply" data-confirm="Link every currently safe premium-user match to its verified Stripe or PayPal subscription?"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><label class="checkRow"><input type="checkbox" name="confirm" value="1"><span>Link only the ${esc(result.counts.safe)} exact customer + plan ${result.counts.safe===1?'match':'matches'}. Ambiguous matches remain untouched.</span></label><button class="button" type="submit">Link safe matches</button></form>` : '';
    return `<section class="section" id="billing-discovery">${ui.sectionHeader({title:'Premium subscription integrity',description:'Every active paid Premium Server user should have a real recurring Stripe or PayPal subscription attached. Discovery never creates a second entitlement and never guesses ambiguous matches.'})}${warning}<div class="operatorCallout ${coverage.missing?'warn':'good'}"><strong>${esc(coverage.linked)} of ${esc(coverage.premium)} premium users are provider-linked.</strong> ${coverage.missing?`${esc(coverage.missing)} still need a billing link.`:'No missing premium billing links are currently detected.'}</div><div class="buttonRow"><form method="post" action="/admin/billing/discover/preview">${csrfInput(req)}<button class="button ${coverage.missing?'':'secondary'}" type="submit">Discover current subscriptions</button></form></div><div class="inlineHelp">Stripe is scanned directly. PayPal uses verified subscription references from Transaction Search/imported history and then checks each subscription against PayPal. Exact provider customer identity or a unique email plus an exact provider-plan mapping is required for automatic linking.</div>${summary}${warnings}${table}${apply}</section>`;
}

async function page(req, options = {}) {
    await runtimeSettings.ensureLoaded();
    const [data, stripeStatus, paypalStatus, coverage] = await Promise.all([billing.dashboardData(),providerSettings.status('stripe'),providerSettings.status('paypal'),discovery.coverageStats()]);
    const recurring=data.subscriptions.filter(row=>row.recurring),problems=recurringProblems(data),failedEvents=data.events.filter(row=>row.processing_error&&!row.processed_at);
    const providerState = `${stripeStatus.configured ? pill('Stripe ready', 'good') : pill('Stripe not ready', stripeStatus.enabled ? 'warn' : '')} ${paypalStatus.configured ? pill('PayPal ready', 'good') : pill('PayPal not ready', paypalStatus.enabled ? 'warn' : '')}`;
    const problemSection=problems.length?`<section class="section" id="billing-problems">${ui.sectionHeader({title:'Fix these subscriptions first',description:'Past-due customers and provider-sync failures. Open the customer journey for context, or sync the subscription directly.'})}${subscriptionTable(req,problems)}</section>`:'';
    const reconciliation=`<section class="section" id="billing-reconcile"><div class="sectionHead"><div><h2>Provider reconciliation</h2><div class="muted">Verifies subscriptions that are already linked to Stripe/PayPal. Use Premium subscription integrity below to discover missing links first.</div></div><div>${providerState}</div></div><div class="billingToolbar"><form method="post" action="/admin/billing/sync-due">${csrfInput(req)}<button class="button secondary" type="submit">Sync due subscriptions</button></form><form method="post" action="/admin/billing/sync-all" data-confirm="Sync every active recurring subscription against the payment providers now?">${csrfInput(req)}<button class="button" type="submit">Sync all now</button></form><a class="button secondary" href="/admin/payments">Gateway settings</a></div><div class="notice">Provider API/network failures never revoke customer access by themselves. Existing subscription state is preserved until authoritative provider state is obtained.</div></section>`;
    const allSubscriptions=ui.detailDisclosure({title:`All recurring subscriptions (${recurring.length})`,summary:'Routine subscription state · open when tracing or changing a specific renewal',bodyHtml:subscriptionTable(req,recurring)});
    const eventSummary=failedEvents.length?`<div class="operatorCallout warn"><strong>${failedEvents.length} recent provider ${failedEvents.length===1?'event has':'events have'} a processing error.</strong><span> Resolve customer-facing effects in Commerce; use the event history below for provider diagnosis.</span></div>`:'';
    const events=ui.detailDisclosure({title:`Recent provider events (${data.events.length})`,summary:failedEvents.length?`${failedEvents.length} failed · diagnostic webhook history`:'Diagnostic webhook history',bodyHtml:data.events.length?`<div class="tableWrap"><table class="dataTable responsiveTable eventTable"><thead><tr><th>Provider</th><th>Event</th><th>Status</th><th>Received</th><th>Error</th></tr></thead><tbody>${data.events.map(eventRow).join('')}</tbody></table></div>`:'<div class="empty">No provider events yet.</div>'});
    const body = `${ui.noticesFromRequest(req)}${billingHero(data,stripeStatus,paypalStatus,coverage)}${problemSection}${reconciliation}${discoverySection(req,coverage,options.discoveryResult,options.discoveryError)}${eventSummary}${allSubscriptions}${events}<style>.billingTable{min-width:1240px}.eventTable{min-width:850px}.discoveryTable{min-width:1100px}.billingToolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.billingToolbar form,.billingActions form,.buttonRow form{margin:0}.billingActions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.buttonRow{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tinyCode{font-size:10px;white-space:nowrap}.errorText{color:#ef9298;max-width:340px;display:inline-block}.discoveryApply{margin-top:12px}@media(max-width:600px){.billingToolbar,.buttonRow,.billingActions{display:grid;grid-template-columns:1fr;width:100%}.billingToolbar form,.buttonRow form,.billingActions form{width:100%}.billingToolbar .button,.buttonRow .button,.billingActions .button,.discoveryApply .button{width:100%;justify-content:center}.billingToolbar>a.button{width:100%;justify-content:center}.sectionHead{align-items:flex-start}.sectionHead>div:last-child{display:flex;gap:6px;flex-wrap:wrap}.tinyCode{white-space:normal;overflow-wrap:anywhere}.discoveryApply .checkRow{align-items:flex-start}}</style>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'billing', title: 'Billing', subtitle: 'Current premium billing integrity, recurring subscription state and provider reconciliation', body });
}

function createAdminBillingRouter() {
    const router = express.Router();
    router.use('/admin/billing', gate, noStore);
    router.get('/admin/billing', async (req, res, next) => { try { return res.send(await page(req)); } catch (error) { return next(error); } });
    router.post('/admin/billing/discover/preview', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { return res.send(await page(req, { discoveryResult: await discovery.preview() })); }
        catch (error) { try { return res.status(400).send(await page(req, { discoveryError: error.message || String(error) })); } catch (renderError) { return next(renderError); } }
    });
    router.post('/admin/billing/discover/apply', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        if (req.body?.confirm !== '1') return res.redirect('/admin/billing?error=' + encodeURIComponent('Tick the confirmation box before linking discovered subscriptions.'));
        try {
            const result = await discovery.apply(req.session.authUserId);
            const detail = result.failed ? ` ${result.failed} safe matches failed revalidation.` : '';
            return res.redirect(`/admin/billing?message=${encodeURIComponent(`Premium subscription discovery linked ${result.linked} subscriptions; ${result.unresolved} remain unresolved.${detail}`)}`);
        } catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Subscription discovery failed.')); }
    });
    router.post('/admin/billing/sync-due', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const result = await billing.syncDue({ all: false, limit: 100 }); return res.redirect(`/admin/billing?message=${encodeURIComponent(`Provider sync complete: ${result.succeeded} succeeded, ${result.failed} failed.`)}`); }
        catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Provider sync failed.')); }
    });
    router.post('/admin/billing/sync-all', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const result = await billing.syncDue({ all: true, limit: 500 }); return res.redirect(`/admin/billing?message=${encodeURIComponent(`Full provider sync complete: ${result.succeeded} succeeded, ${result.failed} failed.`)}`); }
        catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Provider sync failed.')); }
    });
    router.post('/admin/billing/:id/sync', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const result = await billing.syncSubscription(req.params.id); if (!result.ok) throw new Error(result.error); return res.redirect('/admin/billing?message=' + encodeURIComponent('Subscription synchronized with the payment provider.')); }
        catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Subscription could not be synchronized.')); }
    });
    router.post('/admin/billing/:id/stop-renewal', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { await billing.setRenewal(req.params.id, false, req.session.authUserId); return res.redirect('/admin/billing?message=' + encodeURIComponent('Automatic renewal stopped. Existing paid access remains until the paid-through date.')); }
        catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Renewal could not be stopped.')); }
    });
    router.post('/admin/billing/:id/resume-renewal', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { await billing.setRenewal(req.params.id, true, req.session.authUserId); return res.redirect('/admin/billing?message=' + encodeURIComponent('Automatic renewal restored.')); }
        catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Renewal could not be restored.')); }
    });
    return router;
}

module.exports = { createAdminBillingRouter, page, billingHero, recurringProblems, subscriptionTable, subscriptionRow, discoverySection };
