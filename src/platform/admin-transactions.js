'use strict';

const express = require('express');
const browser = require('../payments/transaction-browser');
const liveStripeHistory = require('../payments/live-stripe-payment-history');
const reportingCurrency = require('./reporting-currency');
const runtimeSettings = require('./runtime-settings');
const ui = require('./admin-ui');
const { esc, layout } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) { res.setHeader('Cache-Control','no-store, private, max-age=0'); res.setHeader('Pragma','no-cache'); next(); }
function dateTime(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB'); }
function money(minor, currency) {
    const code = String(currency || 'USD').toUpperCase();
    const zero = ['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'];
    const three = ['BHD','JOD','KWD','OMR','TND'];
    const divisor = zero.includes(code) ? 1 : three.includes(code) ? 1000 : 100;
    try { return new Intl.NumberFormat('en-GB',{style:'currency',currency:code,currencyDisplay:'narrowSymbol'}).format(Number(minor || 0) / divisor); }
    catch { return `${code} ${(Number(minor || 0) / divisor).toFixed(2)}`; }
}
function pill(text, cls='') { return `<span class="pill ${cls}">${esc(text)}</span>`; }
function kindPill(kind) { return kind === 'payment' ? pill('Payment','good') : kind === 'refund' ? pill('Refund','warn') : pill('Provider movement'); }
function providerLabel(provider) { return provider === 'stripe' ? 'Stripe' : provider === 'paypal' ? 'PayPal' : provider; }
function identity(row) { return row.portal_username || row.display_name || row.customer_email || (row.customer_id ? 'Matched customer' : 'Unmatched'); }
function queryString(filters, page) {
    const params = new URLSearchParams();
    for (const key of ['provider','kind','currency','status','q','startDate','endDate']) if (filters[key]) params.set(key, filters[key]);
    if (page > 1) params.set('page', String(page));
    return params.toString();
}
function coverageHtml(rows) {
    if (!rows.length) return `<div class="operatorCallout warn"><strong>No provider transaction history is stored yet.</strong></div>`;
    return `<div class="operatorCallout"><strong>Imported coverage:</strong> ${rows.map(row => `${esc(providerLabel(row.provider))}: ${esc(dateTime(row.first_at))} → ${esc(dateTime(row.last_at))} · ${esc(row.transactions)} records`).join(' &nbsp; · &nbsp; ')}.</div>`;
}
function filterForm(filters) {
    const option=(value,label,current)=>`<option value="${esc(value)}" ${current===value?'selected':''}>${esc(label)}</option>`;
    return `<form class="formPanel transactionFilters" method="get" action="/admin/payments/transactions"><div class="formGrid">
      <div class="formGroup"><label>Provider</label><select class="input" name="provider">${option('all','Stripe + PayPal',filters.provider)}${option('stripe','Stripe',filters.provider)}${option('paypal','PayPal',filters.provider)}</select></div>
      <div class="formGroup"><label>Classification</label><select class="input" name="kind">${option('all','All provider records',filters.kind)}${option('payment','Customer payments',filters.kind)}${option('refund','Refunds / reversals',filters.kind)}${option('ignored','Payouts / other movements',filters.kind)}</select></div>
      <div class="formGroup"><label>Currency</label><input class="input" name="currency" maxlength="8" placeholder="All" value="${esc(filters.currency)}"></div>
      <div class="formGroup"><label>Provider status</label><input class="input" name="status" maxlength="40" placeholder="All" value="${esc(filters.status)}"></div>
      <div class="formGroup"><label>From</label><input class="input" type="date" name="startDate" value="${esc(filters.startDate)}"></div>
      <div class="formGroup"><label>To</label><input class="input" type="date" name="endDate" value="${esc(filters.endDate)}"></div>
      <div class="formGroup transactionSearch"><label>Customer / transaction / reference</label><input class="input" name="q" maxlength="200" placeholder="Email, username, txn ID…" value="${esc(filters.q)}"></div>
    </div><div class="buttonRow"><button class="button" type="submit">Apply filters</button><a class="button secondary" href="/admin/payments/transactions">Clear</a></div></form>`;
}
function transactionRow(row, currencyState) {
    const reportCode = currencyState.currency;
    const reportMinor = reportingCurrency.convertMinor(row.gross_amount_minor, row.currency, reportCode, currencyState);
    const original = money(row.gross_amount_minor,row.currency);
    const normalized = money(reportMinor,reportCode);
    const refBits = [row.provider_transaction_id,row.provider_reference_id,row.provider_source_id].filter(Boolean);
    return `<tr>
      <td data-label="When">${esc(dateTime(row.occurred_at))}</td>
      <td data-label="Provider / type"><strong>${esc(providerLabel(row.provider))}</strong><div class="subText">${esc(row.transaction_type || '—')}</div></td>
      <td data-label="Classification / status">${kindPill(row.kind)}<div class="subText">${esc(row.transaction_status || '—')}</div></td>
      <td data-label="Customer">${row.customer_id?`<a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing"><strong>${esc(identity(row))}</strong></a>`:`<strong>${esc(identity(row))}</strong>`}<div class="subText">${esc(row.customer_email || '')}</div></td>
      <td data-label="Amount (${esc(reportCode)})"><strong>${esc(normalized)}</strong>${String(row.currency).toUpperCase()!==reportCode?`<div class="subText">Original ${esc(original)}</div>`:''}</td>
      <td data-label="Original fee">${esc(money(row.fee_amount_minor,row.currency))}</td>
      <td data-label="Provider IDs"><code class="transactionId">${esc(refBits[0] || '—')}</code>${refBits.length>1?`<details><summary>More IDs</summary>${refBits.slice(1).map(v=>`<div><code class="transactionId">${esc(v)}</code></div>`).join('')}</details>`:''}</td>
    </tr>`;
}
function pagination(result) {
    const prev=result.page>1?`<a class="button secondary" href="/admin/payments/transactions?${esc(queryString(result.filters,result.page-1))}">Previous</a>`:'';
    const next=result.hasNext?`<a class="button secondary" href="/admin/payments/transactions?${esc(queryString(result.filters,result.page+1))}">Next</a>`:'';
    return `<div class="transactionPager">${prev}<span class="muted">Page ${esc(result.page)} · ${esc(result.total)} matching record${Number(result.total)===1?'':'s'}${result.truncated?' scanned so far':''}</span>${next}</div>`;
}
async function page(req) {
    await runtimeSettings.ensureLoaded();
    let liveSyncWarning = '';
    try {
        await liveStripeHistory.syncRecent();
    } catch (error) {
        console.error('Live Stripe payment-history catch-up failed:', error.message || error);
        liveSyncWarning = `<div class="operatorCallout warn"><strong>Stripe live catch-up could not complete.</strong> Stored transactions are still shown below, but very recent Stripe charges may be missing until the provider API is reachable again.</div>`;
    }
    const [result, coverage, currencyState] = await Promise.all([browser.listTransactions(req.query || {}), browser.coverage(), reportingCurrency.get()]);
    const warning = result.truncated ? `<div class="operatorCallout warn"><strong>Very large filtered result.</strong> Classification scanning stopped after ${esc(browser.MAX_CLASSIFIED_SCAN)} provider rows. Narrow the date/provider filters for an exact count.</div>` : '';
    const table = result.rows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable transactionTable"><thead><tr><th>When</th><th>Provider / type</th><th>Classification / status</th><th>Customer</th><th>Amount (${esc(currencyState.currency)})</th><th>Original fee</th><th>Provider IDs</th></tr></thead><tbody>${result.rows.map(row=>transactionRow(row,currencyState)).join('')}</tbody></table></div>${pagination(result)}` : `<div class="empty">No transactions match these filters.</div>`;
    const body = `${ui.noticesFromRequest(req)}${liveSyncWarning}${coverageHtml(coverage)}${filterForm(result.filters)}${warning}<section class="section">${ui.sectionHeader({title:'Stripe + PayPal transactions',description:`Full imported provider ledger. Business-facing amounts are normalized to ${currencyState.currency}; original provider currency and IDs remain visible for reconciliation.`})}${table}</section><style>.transactionTable{min-width:1220px}.transactionFilters .formGrid{grid-template-columns:repeat(3,minmax(180px,1fr))}.transactionSearch{grid-column:span 2}.transactionId{font-size:10px;word-break:break-all}.transactionPager{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:12px;flex-wrap:wrap}.buttonRow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}@media(max-width:850px){.transactionFilters .formGrid{grid-template-columns:1fr}.transactionSearch{grid-column:auto}}@media(max-width:600px){.transactionFilters{padding:12px}.transactionFilters .buttonRow{display:grid;grid-template-columns:1fr}.transactionFilters .buttonRow .button{width:100%;justify-content:center}.transactionPager{display:grid;grid-template-columns:1fr;text-align:center}.transactionPager .button{width:100%;justify-content:center}.transactionId{overflow-wrap:anywhere;word-break:break-word}.operatorCallout{overflow-wrap:anywhere}}</style>`;
    return layout({siteName:runtimeSettings.siteName(),active:'transactions',title:'Transactions',subtitle:'Every imported Stripe and PayPal provider transaction in one searchable ledger',body});
}
function createAdminTransactionsRouter() {
    const router=express.Router();
    router.use('/admin/payments/transactions',gate,noStore);
    router.get('/admin/payments/transactions',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){return next(error);}});
    return router;
}
module.exports={createAdminTransactionsRouter,page,filterForm,transactionRow};
