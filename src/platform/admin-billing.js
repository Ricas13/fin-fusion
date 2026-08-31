'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const billing = require('../payments/billing-control');
const discovery = require('../payments/subscription-discovery');
const manualLink = require('../payments/manual-subscription-link');
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
    const problems=recurringProblems(data),pastDue=problems.filter(row=>row.status==='past_due').length,providerProblem=(stripeStatus.enabled&&!stripeStatus.configured)||(paypalStatus.enabled&&!paypalStatus.configured),missing=Number(coverage.missing||0);
    const tone=problems.length?'bad':missing?'warn':providerProblem?'warn':'commerce';
    const title=problems.length?`${problems.length} recurring ${problems.length===1?'subscription needs':'subscriptions need'} attention`:missing?`${missing} premium ${missing===1?'user is':'users are'} missing a provider subscription`:providerProblem?'A payment provider needs configuration':'Recurring billing is clear';
    const next=problems[0]?`Open ${problems[0].portal_username||problems[0].display_name||problems[0].email||'the first customer'} and synchronize the provider state before changing renewal.`:missing?'Resolve the missing provider links below before their local paid-through dates expire.':providerProblem?'Finish the enabled provider configuration in Payments.':'No billing intervention is required; use Sync due for routine reconciliation.';
    return ui.operatorHero({tone,eyebrow:'Billing operations',title,body:'Every active paid Premium Server entitlement should resolve to a current provider subscription. Missing links are operator work and remain visible until resolved.',statusLabel:problems.length?'Action required':missing?'Missing billing links':providerProblem?'Setup incomplete':'Billing healthy',next,facts:[{label:'Premium users',value:String(coverage.premium||0),detail:'active paid Premium Server entitlements'},{label:'Provider linked',value:String(coverage.linked||0),detail:'premium users with recurring billing IDs'},{label:'Missing link',value:String(missing),detail:'visible below until resolved'},{label:'Past due',value:String(pastDue),detail:'customer payment attention'}],actionsHtml:problems[0]?`<a class="button" href="/admin/users/${encodeURIComponent(problems[0].customer_id)}?tab=billing">Open first affected customer</a><a class="button secondary" href="#billing-problems">Billing problems</a>`:missing?'<a class="button" href="#missing-provider-links">Resolve missing links</a><a class="button secondary" href="#billing-discovery">Run discovery</a>':'<a class="button secondary" href="#billing-reconcile">Reconcile due</a><a class="button secondary" href="/admin/payments">Payment providers</a>'});
}

function expiryUrgency(row) {
    const end = row.current_period_end ? new Date(row.current_period_end) : null;
    if (!end || Number.isNaN(end.getTime())) return { label: 'Unknown expiry', cls: 'warn', detail: 'Verify before changing access' };
    const ms = end.getTime() - Date.now();
    if (ms <= 0) return { label: 'Expired locally', cls: 'bad', detail: date(end) };
    const hours = Math.ceil(ms / 3600000);
    if (hours <= 72) return { label: hours <= 24 ? `Expires in ${hours}h` : `Expires in ${Math.ceil(hours/24)}d`, cls: 'bad', detail: date(end) };
    const days = Math.ceil(hours / 24);
    if (days <= 14) return { label: `Expires in ${days}d`, cls: 'warn', detail: date(end) };
    return { label: `Expires in ${days}d`, cls: '', detail: date(end) };
}
function manualResolveForm(req, row) {
    return `<details class="manualResolve"><summary class="button secondary btn-sm">Resolve</summary><form method="post" action="/admin/billing/${encodeURIComponent(row.subscription_id)}/manual-preview#manual-provider-preview" class="manualResolveForm">${csrfInput(req)}<div class="formGroup"><label>Provider</label><select class="input" name="provider" required><option value="paypal">PayPal</option><option value="stripe">Stripe</option></select></div><div class="formGroup"><label>Provider subscription ID</label><input class="input" name="providerSubscriptionId" maxlength="255" placeholder="I-… or sub_…" required></div><button class="button btn-sm" type="submit">Verify subscription</button><div class="subText">CAPTAiNFiN will reload this section with the provider result before anything is linked.</div></form></details>`;
}
function missingProviderRow(req, row) {
    const identity = row.portal_username || row.display_name || row.email || 'Customer';
    const urgency = expiryUrgency(row);
    return `<tr><td data-label="Customer"><a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(row.email||'')}</div></td><td data-label="Plan"><strong>${esc(row.plan_name||row.plan_code||'Premium')}</strong><div class="subText">${esc(row.plan_code||'')}</div></td><td data-label="Local source">${pill(row.source||'unknown','warn')}</td><td data-label="Paid through">${esc(date(row.current_period_end))}</td><td data-label="Urgency">${pill(urgency.label,urgency.cls)}<div class="subText">${esc(urgency.detail)}</div></td><td data-label="Action" class="right">${manualResolveForm(req,row)}</td></tr>`;
}
function manualResolutionSection(req, result = null, error = null, attempt = null) {
    if (!result && !error) return '';
    if (error) {
        const attemptedProvider = providerLabel(attempt?.provider || 'provider');
        const attemptedId = String(attempt?.providerSubscriptionId || '').trim();
        return `<div class="manualResolution manualVerificationResult" id="manual-provider-preview" tabindex="-1" aria-live="polite">${ui.sectionHeader({title:'Subscription verification failed',description:'Nothing was linked. Fix the provider ID or mapping and try again.'})}<div class="operatorCallout bad"><strong>${esc(attemptedProvider)} verification failed${attemptedId?` for ${esc(attemptedId)}`:''}.</strong><div class="subText">${esc(error)}</div></div><div class="buttonRow"><a class="button secondary" href="#missing-provider-links">Back to missing subscriptions</a></div></div>`;
    }
    const local = result.local || {}, remote = result.remote || {}, identity = local.portal_username || local.display_name || local.email || 'Customer';
    const identityState = result.identity?.verified ? pill('Identity verified','good') : pill('Manual ownership check required','warn');
    const apiFamily = remote.apiFamily === 'billing-agreements-v1' ? 'Legacy Billing Agreement' : 'Current subscription API';
    const emailComparison = `<div class="manualCompare"><div><span class="muted">Portal customer</span><strong>${esc(local.email||identity)}</strong></div><div><span class="muted">Provider subscriber</span><strong>${esc(remote.email||'No email returned')}</strong></div></div>`;
    return `<div class="manualResolution manualVerificationResult" id="manual-provider-preview" tabindex="-1" aria-live="polite">${ui.sectionHeader({title:'Subscription verified — review before linking',description:'CAPTAiNFiN read this subscription directly from the provider. Nothing has been changed yet.'})}<div class="operatorCallout good"><strong>Provider verification succeeded.</strong> Review the customer, plan and renewal details below, then explicitly confirm the link.</div><div class="operatorCallout ${result.identity?.verified?'good':'warn'}"><strong>${esc(identity)}</strong> · ${identityState}<div class="subText">${esc(result.identity?.reason||'')}</div></div>${emailComparison}<div class="metrics"><div class="metric"><div class="metricLabel">Provider</div><div class="metricValue smallMetric">${esc(providerLabel(remote.provider))}</div></div><div class="metric"><div class="metricLabel">Subscription</div><div class="metricValue smallMetric"><code>${esc(remote.id||'—')}</code></div></div><div class="metric"><div class="metricLabel">Provider state</div><div class="metricValue smallMetric">${esc(remote.status||'—')}</div></div><div class="metric"><div class="metricLabel">Next billing / period end</div><div class="metricValue smallMetric">${esc(date(remote.periodEnd))}</div></div><div class="metric"><div class="metricLabel">PayPal API</div><div class="metricValue smallMetric">${esc(apiFamily)}</div></div></div><div class="operatorCallout"><strong>Plan verified:</strong> ${esc((result.externalPlanIds||[]).join(', '))} maps to ${esc(local.plan_name||local.plan_code||'this local plan')}.</div><form method="post" action="/admin/billing/${encodeURIComponent(local.subscription_id)}/manual-link" class="formPanel manualLinkConfirm" data-confirm="Attach this verified provider subscription to the selected customer?">${csrfInput(req)}<input type="hidden" name="provider" value="${esc(remote.provider)}"><input type="hidden" name="providerSubscriptionId" value="${esc(remote.id)}"><label class="checkRow"><input type="checkbox" name="confirm" value="1"><span>I verified that this ${esc(providerLabel(remote.provider))} subscription belongs to <strong>${esc(local.email||identity)}</strong>. Link it to the existing entitlement and use provider state for future renewals.</span></label><div class="buttonRow"><button class="button" type="submit">Link verified subscription</button><a class="button secondary" href="/admin/billing#missing-provider-links">Cancel</a></div></form></div>`;
}
function missingProviderLinksSection(req, rows, manualResult = null, manualError = null, manualAttempt = null) {
    if (!rows.length) return `<section class="section" id="missing-provider-links">${ui.sectionHeader({title:'Missing provider links',description:'No active paid Premium Server customers are currently waiting for a provider subscription link.'})}<div class="operatorCallout good"><strong>All premium recurring billing identities are linked.</strong></div></section>`;
    const verification = manualResolutionSection(req, manualResult, manualError, manualAttempt);
    const table = `<div class="tableWrap"><table class="dataTable responsiveTable missingLinkTable"><thead><tr><th>Customer</th><th>Plan</th><th>Local source</th><th>Paid through</th><th>Urgency</th><th class="right">Action</th></tr></thead><tbody>${rows.map(row=>missingProviderRow(req,row)).join('')}</tbody></table></div>`;
    return `<section class="section" id="missing-provider-links">${ui.sectionHeader({title:`Missing provider links (${rows.length})`,description:'These paid Premium customers are not in the healthy recurring table because no real Stripe/PayPal recurring ID is attached. They remain visible here until fixed.'})}<div class="operatorCallout bad"><strong>Action required.</strong> A local migration expiry can disable access if the real provider subscription is not linked first. Run discovery for automatic matches, or Resolve a row with the provider subscription ID.</div>${verification}${table}</section>`;
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
    const tableRows = (result?.rows || []).filter(item=>item.state!=='linked');
    const table = tableRows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable discoveryTable"><thead><tr><th>Premium user</th><th>Local plan</th><th>Provider subscription</th><th>Provider state</th><th>Match</th><th>Reason</th></tr></thead><tbody>${tableRows.map(discoveryRow).join('')}</tbody></table></div>` : result ? '<div class="operatorCallout good"><strong>No missing provider links remain after discovery.</strong></div>' : '';
    const apply = result?.counts.safe ? `<form method="post" action="/admin/billing/discover/apply" class="formPanel discoveryApply" data-confirm="Link every currently safe premium-user match to its verified Stripe or PayPal subscription?"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><label class="checkRow"><input type="checkbox" name="confirm" value="1"><span>Link only the ${esc(result.counts.safe)} exact customer + plan ${result.counts.safe===1?'match':'matches'}. Ambiguous matches remain untouched.</span></label><button class="button" type="submit">Link safe matches</button></form>` : '';
    return `<section class="section" id="billing-discovery">${ui.sectionHeader({title:'Automatic provider discovery',description:'Scan Stripe and PayPal for missing recurring identities. Healthy linked subscriptions are omitted from the results so the table contains only work that needs attention.'})}${warning}<div class="operatorCallout ${coverage.missing?'warn':'good'}"><strong>${esc(coverage.linked)} of ${esc(coverage.premium)} premium users are provider-linked.</strong> ${coverage.missing?`${esc(coverage.missing)} still need a billing link.`:'No missing premium billing links are currently detected.'}</div><div class="buttonRow"><form method="post" action="/admin/billing/discover/preview">${csrfInput(req)}<button class="button ${coverage.missing?'':'secondary'}" type="submit">Discover current subscriptions</button></form></div><div class="inlineHelp">Stripe is scanned directly. PayPal uses verified subscription references from Transaction Search/imported history and then checks each subscription against PayPal. Exact provider customer identity or a unique email plus an exact provider-plan mapping is required for automatic linking.</div>${summary}${warnings}${table}${apply}</section>`;
}

async function page(req, options = {}) {
    await runtimeSettings.ensureLoaded();
    const [data, stripeStatus, paypalStatus, coverage, premiumRows] = await Promise.all([billing.dashboardData(),providerSettings.status('stripe'),providerSettings.status('paypal'),discovery.coverageStats(),discovery.premiumEntitlements()]);
    const recurring=data.subscriptions.filter(row=>row.recurring),problems=recurringProblems(data),failedEvents=data.events.filter(row=>row.processing_error&&!row.processed_at);
    const missingRows=premiumRows.filter(row=>!discovery.recurringId(row.source,row.provider_subscription_id)).sort((a,b)=>new Date(a.current_period_end||'9999-12-31')-new Date(b.current_period_end||'9999-12-31'));
    const providerState = `${stripeStatus.configured ? pill('Stripe ready', 'good') : pill('Stripe not ready', stripeStatus.enabled ? 'warn' : '')} ${paypalStatus.configured ? pill('PayPal ready', 'good') : pill('PayPal not ready', paypalStatus.enabled ? 'warn' : '')}`;
    const problemSection=problems.length?`<section class="section" id="billing-problems">${ui.sectionHeader({title:'Fix these subscriptions first',description:'Past-due customers and provider-sync failures. Open the customer journey for context, or sync the subscription directly.'})}${subscriptionTable(req,problems)}</section>`:'';
    const reconciliation=`<section class="section" id="billing-reconcile"><div class="sectionHead"><div><h2>Provider reconciliation</h2><div class="muted">Verifies subscriptions that are already linked to Stripe/PayPal. Missing links are handled in the operator queue above.</div></div><div>${providerState}</div></div><div class="billingToolbar"><form method="post" action="/admin/billing/sync-due">${csrfInput(req)}<button class="button secondary" type="submit">Sync due subscriptions</button></form><form method="post" action="/admin/billing/sync-all" data-confirm="Sync every active recurring subscription against the payment providers now?">${csrfInput(req)}<button class="button" type="submit">Sync all now</button></form><a class="button secondary" href="/admin/payments">Gateway settings</a></div><div class="notice">Provider API/network failures never revoke customer access by themselves. Existing subscription state is preserved until authoritative provider state is obtained.</div></section>`;
    const allSubscriptions=ui.detailDisclosure({title:`Healthy / linked recurring subscriptions (${recurring.length})`,summary:'Reference list for subscriptions that already have a real provider recurring identity',bodyHtml:subscriptionTable(req,recurring)});
    const eventSummary=failedEvents.length?`<div class="operatorCallout warn"><strong>${failedEvents.length} recent provider ${failedEvents.length===1?'event has':'events have'} a processing error.</strong><span> Resolve customer-facing effects in Commerce; use the event history below for provider diagnosis.</span></div>`:'';
    const events=ui.detailDisclosure({title:`Recent provider events (${data.events.length})`,summary:failedEvents.length?`${failedEvents.length} failed · diagnostic webhook history`:'Diagnostic webhook history',bodyHtml:data.events.length?`<div class="tableWrap"><table class="dataTable responsiveTable eventTable"><thead><tr><th>Provider</th><th>Event</th><th>Status</th><th>Received</th><th>Error</th></tr></thead><tbody>${data.events.map(eventRow).join('')}</tbody></table></div>`:'<div class="empty">No provider events yet.</div>'});
    const body = `${ui.noticesFromRequest(req)}${billingHero(data,stripeStatus,paypalStatus,coverage)}${problemSection}${missingProviderLinksSection(req,missingRows,options.manualResolution,options.manualError,options.manualAttempt)}${discoverySection(req,coverage,options.discoveryResult,options.discoveryError)}${reconciliation}${eventSummary}${allSubscriptions}${events}<style>.billingTable{min-width:1240px}.eventTable{min-width:850px}.discoveryTable{min-width:1100px}.missingLinkTable{min-width:980px}.billingToolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.billingToolbar form,.billingActions form,.buttonRow form{margin:0}.billingActions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.buttonRow{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tinyCode{font-size:10px;white-space:nowrap}.errorText{color:#ef9298;max-width:340px;display:inline-block}.discoveryApply{margin-top:12px}.manualResolve{display:inline-block}.manualResolve summary{list-style:none;cursor:pointer}.manualResolve summary::-webkit-details-marker{display:none}.manualResolveForm{min-width:280px;margin-top:8px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.manualResolveForm .formGroup{margin-bottom:8px}.manualResolution{scroll-margin-top:20px;margin:14px 0;padding:14px;border:1px solid var(--border);border-radius:14px;background:var(--panel)}.manualResolution:target{outline:2px solid var(--accent);outline-offset:3px}.manualCompare{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.manualCompare>div{padding:12px;border:1px solid var(--border);border-radius:12px}.manualCompare span,.manualCompare strong{display:block}.smallMetric{font-size:15px!important;overflow-wrap:anywhere}.manualLinkConfirm{margin-top:12px}@media(max-width:600px){.billingToolbar,.buttonRow,.billingActions{display:grid;grid-template-columns:1fr;width:100%}.billingToolbar form,.buttonRow form,.billingActions form{width:100%}.billingToolbar .button,.buttonRow .button,.billingActions .button,.discoveryApply .button,.manualResolve summary.button,.manualResolveForm .button,.manualLinkConfirm .button{width:100%;justify-content:center}.billingToolbar>a.button{width:100%;justify-content:center}.sectionHead{align-items:flex-start}.sectionHead>div:last-child{display:flex;gap:6px;flex-wrap:wrap}.tinyCode{white-space:normal;overflow-wrap:anywhere}.discoveryApply .checkRow,.manualLinkConfirm .checkRow{align-items:flex-start}.manualResolve{display:block;width:100%}.manualResolveForm{min-width:0;width:100%}.manualCompare{grid-template-columns:1fr}}</style>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'billing', title: 'Billing', subtitle: 'Current premium billing integrity, missing provider links and provider reconciliation', body });
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
            return res.redirect(`/admin/billing?message=${encodeURIComponent(`Premium subscription discovery linked ${result.linked} subscriptions; ${result.unresolved} remain unresolved.${detail}`)}#missing-provider-links`);
        } catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Subscription discovery failed.')); }
    });
    router.post('/admin/billing/:id/manual-preview', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const manualAttempt = { subscriptionId:req.params.id, provider:req.body?.provider, providerSubscriptionId:req.body?.providerSubscriptionId };
        try {
            const result = await manualLink.preview(manualAttempt);
            return res.send(await page(req, { manualResolution: result, manualAttempt }));
        } catch (error) {
            try { return res.status(400).send(await page(req, { manualError: error.message || String(error), manualAttempt })); }
            catch (renderError) { return next(renderError); }
        }
    });
    router.post('/admin/billing/:id/manual-link', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        if (req.body?.confirm !== '1') return res.redirect('/admin/billing?error=' + encodeURIComponent('Confirm provider ownership before linking the subscription.') + '#missing-provider-links');
        try {
            await manualLink.apply({ subscriptionId:req.params.id, provider:req.body?.provider, providerSubscriptionId:req.body?.providerSubscriptionId, actorUserId:req.session.authUserId, operatorConfirmed:true });
            return res.redirect('/admin/billing?message=' + encodeURIComponent('Verified provider subscription linked. Provider state now controls future renewal and paid-through updates.') + '#missing-provider-links');
        } catch (error) { return res.redirect('/admin/billing?error=' + encodeURIComponent(error.message || 'Provider subscription could not be linked.') + '#missing-provider-links'); }
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

module.exports = { createAdminBillingRouter, page, billingHero, recurringProblems, subscriptionTable, subscriptionRow, discoverySection, missingProviderLinksSection, expiryUrgency, manualResolutionSection };