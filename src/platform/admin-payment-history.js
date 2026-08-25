'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const providerSettings = require('../payments/provider-settings');
const historyImport = require('../payments/history-import');
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
function dateOnly(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB'); }
function dateTime(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB'); }
function money(minor, currency) {
    try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: String(currency || 'GBP').toUpperCase(), currencyDisplay: 'narrowSymbol' }).format(Number(minor || 0) / (['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(String(currency || '').toUpperCase()) ? 1 : ['BHD','JOD','KWD','OMR','TND'].includes(String(currency || '').toUpperCase()) ? 1000 : 100)); }
    catch { return `${esc(currency || '')} ${(Number(minor || 0) / 100).toFixed(2)}`; }
}
function providerLabel(value) { return value === 'stripe' ? 'Stripe' : value === 'paypal' ? 'PayPal' : value === 'both' ? 'Stripe + PayPal' : String(value || '—'); }

function defaults() {
    const year = new Date().getUTCFullYear();
    return { provider: 'both', startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}
function selected(value, expected) { return value === expected ? 'selected' : ''; }

function importForm(req, values, statuses) {
    const paypalEnvironment = statuses.paypal.environment === 'live' ? 'Live' : 'Sandbox';
    return `<section class="section" id="history-import">${ui.sectionHeader({ title: 'Import provider history', description: 'Backfill Stripe and PayPal accounting into a separate read-only historical ledger. Preview performs no writes.' })}
      <div class="operatorCallout warn"><strong>Access safety:</strong> historical transactions never activate, extend or restore customer access. Current provider subscription state and verified checkout/webhook flows remain authoritative.</div>
      <form class="formPanel" method="post" action="/admin/payments/history/preview">
        ${csrfInput(req)}
        <div class="formGrid">
          <div class="formGroup"><label>Provider</label><select class="input" name="provider"><option value="both" ${selected(values.provider,'both')}>Stripe + PayPal</option><option value="stripe" ${selected(values.provider,'stripe')}>Stripe</option><option value="paypal" ${selected(values.provider,'paypal')}>PayPal</option></select><div class="inlineHelp">PayPal currently points at <strong>${esc(paypalEnvironment)}</strong>. Disabled gateways can still be imported when saved credentials remain available.</div></div>
          <div class="formGroup"><label>Start date</label><input class="input" type="date" name="startDate" value="${esc(values.startDate)}" required></div>
          <div class="formGroup"><label>End date</label><input class="input" type="date" name="endDate" value="${esc(values.endDate)}" required><div class="inlineHelp">Maximum ${historyImport.MAX_RANGE_DAYS} days per run.</div></div>
        </div>
        <label class="checkRow"><input type="checkbox" name="confirm" value="1"><span>I understand this writes historical accounting records only and does not change customer access.</span></label>
        <div class="buttonRow"><button class="button secondary" type="submit">Preview import</button><button class="button" type="submit" formaction="/admin/payments/history/import">Import transactions</button><a class="button secondary" href="/admin/payments">Back to provider health</a></div>
      </form>
      <div class="operatorCallout">Stripe imports Balance Transactions, including fees/net effects. Customer matching is enriched from readable Charges when permitted. PayPal uses Transaction Search and is automatically split into provider-safe 31-day windows.</div>
    </section>`;
}

function summaryCards(summary) {
    if (!summary) return '';
    return `<div class="metrics">
      <div class="metric"><div class="metricLabel">Transactions found</div><div class="metricValue">${esc(summary.total)}</div></div>
      <div class="metric"><div class="metricLabel">New to CAPTAiNFiN</div><div class="metricValue">${esc(summary.newCount)}</div></div>
      <div class="metric"><div class="metricLabel">Already imported</div><div class="metricValue">${esc(summary.existingCount)}</div></div>
      <div class="metric"><div class="metricLabel">Matched customer</div><div class="metricValue">${esc(summary.matchedCount)}</div><div class="subText">${esc(summary.unmatchedCount)} unresolved/ambiguous</div></div>
    </div>`;
}

function totalsTable(summary) {
    const rows = Object.entries(summary?.byCurrency || {});
    if (!rows.length) return '<div class="empty">No transactions were returned for this range.</div>';
    return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Currency</th><th>Transactions</th><th>Gross movement</th><th>Provider fees</th><th>Net movement</th></tr></thead><tbody>${rows.map(([currency,row]) => `<tr><td><strong>${esc(currency)}</strong></td><td>${esc(row.transactions)}</td><td>${esc(money(row.grossAmountMinor,currency))}</td><td>${esc(money(row.feeAmountMinor,currency))}</td><td>${esc(money(row.netAmountMinor,currency))}</td></tr>`).join('')}</tbody></table></div>`;
}

function warnings(summary) {
    return (summary?.warnings || []).map(text => `<div class="operatorCallout warn">${esc(text)}</div>`).join('');
}

function previewSection(result, imported = false) {
    if (!result) return '';
    const summary = result.summary;
    const sample = result.sample || [];
    return `<section class="section">${ui.sectionHeader({ title: imported ? 'Import completed' : 'Preview', description: imported ? `Run ${result.runId} completed. Existing rows were refreshed safely.` : 'Nothing has been written yet. Review the counts and totals before importing.' })}${warnings(summary)}${summaryCards(summary)}${totalsTable(summary)}${sample.length ? `<details class="operatorDisclosure"><summary>Transaction sample (${sample.length}${summary.total > sample.length ? ` of ${summary.total}` : ''})</summary><div class="operatorDisclosureBody"><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>When</th><th>Provider</th><th>Type</th><th>Gross</th><th>Fee</th><th>Net</th><th>Customer</th></tr></thead><tbody>${sample.map(row => `<tr><td>${esc(dateTime(row.occurredAt))}</td><td>${esc(providerLabel(row.provider))}</td><td>${esc(row.transactionType)}</td><td>${esc(money(row.grossAmountMinor,row.currency))}</td><td>${esc(money(row.feeAmountMinor,row.currency))}</td><td>${esc(money(row.netAmountMinor,row.currency))}</td><td>${row.customerId ? `<a href="/admin/users/${encodeURIComponent(row.customerId)}">Matched</a>` : '<span class="muted">Unmatched</span>'}</td></tr>`).join('')}</tbody></table></div></div></details>` : ''}</section>`;
}

function ledgerSection(rows) {
    if (!rows.length) return `<section class="section">${ui.sectionHeader({ title: 'Historical ledger', description: 'No historical provider transactions have been imported yet.' })}<div class="empty">Run a preview above to begin.</div></section>`;
    return `<section class="section">${ui.sectionHeader({ title: 'Historical ledger', description: 'Accounting totals already stored by provider and currency. These records are not used for entitlement decisions.' })}<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Provider</th><th>Currency</th><th>Transactions</th><th>Gross movement</th><th>Fees</th><th>Net movement</th><th>Coverage</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(providerLabel(row.provider))}</td><td>${esc(row.currency)}</td><td>${esc(row.transactions)}</td><td>${esc(money(row.gross_amount_minor,row.currency))}</td><td>${esc(money(row.fee_amount_minor,row.currency))}</td><td>${esc(money(row.net_amount_minor,row.currency))}</td><td>${esc(dateOnly(row.first_at))} – ${esc(dateOnly(row.last_at))}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function runsSection(rows) {
    if (!rows.length) return '';
    return `<section class="section">${ui.sectionHeader({ title: 'Recent imports', description: 'Each committed run is audit logged and can be repeated safely.' })}<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>When</th><th>Provider</th><th>Range</th><th>Seen</th><th>New</th><th>Existing</th><th>Matched</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(dateTime(row.created_at))}</td><td>${esc(providerLabel(row.provider_scope))}</td><td>${esc(dateOnly(row.range_start))} – ${esc(dateOnly(row.range_end))}</td><td>${esc(row.total_seen)}</td><td>${esc(row.imported_count)}</td><td>${esc(row.existing_count)}</td><td>${esc(row.matched_count)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

async function page(req, options = {}) {
    await Promise.all([runtimeSettings.ensureLoaded(), providerSettings.ensureLoaded()]);
    const [runs, ledger, stripe, paypal] = await Promise.all([historyImport.recentRuns(), historyImport.ledgerSummary(), providerSettings.status('stripe'), providerSettings.status('paypal')]);
    const values = { ...defaults(), ...(options.values || {}) };
    const result = options.importResult ? { ...options.importResult, sample: [] } : options.previewResult;
    const notice = options.error ? `<div class="operatorCallout bad"><strong>Import stopped:</strong> ${esc(options.error)}</div>` : options.importResult ? `<div class="operatorCallout good"><strong>Historical import completed.</strong> ${esc(options.importResult.summary.newCount)} new transactions were added; ${esc(options.importResult.summary.existingCount)} existing transactions were refreshed.</div>` : '';
    const body = `${ui.noticesFromRequest(req)}${notice}${importForm(req,values,{stripe,paypal})}${previewSection(result,Boolean(options.importResult))}${ledgerSection(ledger)}${runsSection(runs)}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'payment-history', title: 'Payment History', subtitle: 'Preview and backfill Stripe/PayPal accounting without changing customer access', body });
}

function valuesFrom(req) {
    return { provider: String(req.body?.provider || ''), startDate: String(req.body?.startDate || ''), endDate: String(req.body?.endDate || '') };
}

function createAdminPaymentHistoryRouter() {
    const router = express.Router();
    router.use('/admin/payments/history', gate, noStore);
    router.get('/admin/payments/history', async (req, res, next) => { try { return res.send(await page(req)); } catch (error) { return next(error); } });
    router.post('/admin/payments/history/preview', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const values = valuesFrom(req);
        try {
            const previewResult = await historyImport.preview(values);
            return res.send(await page(req, { values, previewResult }));
        } catch (error) {
            try { return res.status(400).send(await page(req, { values, error: error.message || String(error) })); } catch (renderError) { return next(renderError); }
        }
    });
    router.post('/admin/payments/history/import', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const values = valuesFrom(req);
        if (req.body?.confirm !== '1') return res.status(400).send(await page(req, { values, error: 'Tick the confirmation box before committing a historical import.' }));
        try {
            const importResult = await historyImport.importHistory(values, req.session.authUserId);
            return res.send(await page(req, { values, importResult }));
        } catch (error) {
            try { return res.status(400).send(await page(req, { values, error: error.message || String(error) })); } catch (renderError) { return next(renderError); }
        }
    });
    return router;
}

module.exports = { createAdminPaymentHistoryRouter, page, defaults };
