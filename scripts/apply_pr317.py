from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD = 'origin/feature/current-subscription-discovery'


def copy_old(path):
    data = subprocess.check_output(['git', 'show', f'{OLD}:{path}'], cwd=ROOT)
    (ROOT / path).write_bytes(data)


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'patch target not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# Bring the already-reviewed subscription discovery implementation forward onto
# current main. Later CSV migration changes did not own these files.
for path in [
    'src/payments/subscription-discovery.js',
    'src/payments/lifecycle.js',
    'src/platform/admin-billing.js',
    'scripts/subscription-discovery-smoke.js',
]:
    copy_old(path)

transaction_service = r'''\
'use strict';

const { query } = require('../db');
const historyAccounting = require('./history-accounting');

const PAGE_SIZE = 100;
const SCAN_BATCH = 2000;
const MAX_CLASSIFIED_SCAN = 100000;
const PROVIDERS = new Set(['all', 'stripe', 'paypal']);
const KINDS = new Set(['all', 'payment', 'refund', 'ignored']);

function clean(value, max = 320) { return String(value == null ? '' : value).trim().slice(0, max); }
function positiveInt(value, fallback = 1) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function normalizeFilters(input = {}) {
    const provider = PROVIDERS.has(clean(input.provider, 20).toLowerCase()) ? clean(input.provider, 20).toLowerCase() : 'all';
    const kind = KINDS.has(clean(input.kind, 20).toLowerCase()) ? clean(input.kind, 20).toLowerCase() : 'all';
    const currency = clean(input.currency, 8).toUpperCase();
    const status = clean(input.status, 40);
    const q = clean(input.q, 200);
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(clean(input.startDate, 10)) ? clean(input.startDate, 10) : '';
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(clean(input.endDate, 10)) ? clean(input.endDate, 10) : '';
    const page = Math.min(10000, positiveInt(input.page, 1));
    return { provider, kind, currency, status, q, startDate, endDate, page };
}

function whereClause(filters, params) {
    const clauses = ['1=1'];
    const add = value => { params.push(value); return `$${params.length}`; };
    if (filters.provider !== 'all') clauses.push(`t.provider=${add(filters.provider)}`);
    if (filters.currency) clauses.push(`UPPER(t.currency)=${add(filters.currency)}`);
    if (filters.status) clauses.push(`LOWER(COALESCE(t.transaction_status,''))=LOWER(${add(filters.status)})`);
    if (filters.startDate) clauses.push(`t.occurred_at>=${add(filters.startDate)}::date`);
    if (filters.endDate) clauses.push(`t.occurred_at<(${add(filters.endDate)}::date + INTERVAL '1 day')`);
    if (filters.q) {
        const needle = `%${filters.q}%`;
        const p = add(needle);
        clauses.push(`(
            COALESCE(c.email,'') ILIKE ${p} OR COALESCE(c.display_name,'') ILIKE ${p} OR COALESCE(u.username,'') ILIKE ${p}
            OR COALESCE(t.provider_transaction_id,'') ILIKE ${p} OR COALESCE(t.provider_customer_id,'') ILIKE ${p}
            OR COALESCE(t.provider_reference_id,'') ILIKE ${p} OR COALESCE(t.provider_source_id,'') ILIKE ${p}
            OR COALESCE(t.transaction_type,'') ILIKE ${p}
        )`);
    }
    return clauses.join(' AND ');
}

function rowSelect() {
    return `SELECT t.id,t.provider,t.provider_transaction_id,t.transaction_type,t.transaction_status,t.occurred_at,t.currency,
                   t.gross_amount_minor,t.fee_amount_minor,t.net_amount_minor,t.provider_customer_id,t.provider_reference_id,
                   t.provider_source_id,t.customer_id,t.metadata,
                   COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) AS customer_email,
                   c.display_name,u.username AS portal_username
              FROM payment_history_transactions t
              LEFT JOIN customers c ON c.id=t.customer_id
              LEFT JOIN app_users u ON u.id=c.user_id`;
}

function classify(row) { return historyAccounting.historyKind(row) || 'ignored'; }

async function fetchBase(filters, limit, offset) {
    const params = [];
    const where = whereClause(filters, params);
    params.push(limit, offset);
    return query(`${rowSelect()} WHERE ${where} ORDER BY t.occurred_at DESC,t.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
}

async function baseCount(filters) {
    const params = [];
    const where = whereClause(filters, params);
    const result = await query(`SELECT COUNT(*)::bigint AS total FROM payment_history_transactions t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE ${where}`, params);
    return Number(result.rows[0]?.total || 0);
}

async function listTransactions(input = {}) {
    const filters = normalizeFilters(input);
    const start = (filters.page - 1) * PAGE_SIZE;
    if (filters.kind === 'all') {
        const [total, page] = await Promise.all([baseCount(filters), fetchBase(filters, PAGE_SIZE, start)]);
        const rows = page.rows.map(row => ({ ...row, kind: classify(row) }));
        return { filters, rows, total, page: filters.page, pageSize: PAGE_SIZE, hasNext: start + rows.length < total, truncated: false };
    }

    const wanted = filters.kind;
    const rows = [];
    let offset = 0, matched = 0, scanned = 0, exhausted = false;
    while (!exhausted && scanned < MAX_CLASSIFIED_SCAN) {
        const batch = await fetchBase(filters, SCAN_BATCH, offset);
        if (!batch.rows.length) break;
        for (const raw of batch.rows) {
            const row = { ...raw, kind: classify(raw) };
            if (row.kind !== wanted) continue;
            if (matched >= start && rows.length < PAGE_SIZE) rows.push(row);
            matched += 1;
        }
        scanned += batch.rows.length;
        offset += batch.rows.length;
        exhausted = batch.rows.length < SCAN_BATCH;
    }
    const truncated = !exhausted && scanned >= MAX_CLASSIFIED_SCAN;
    return { filters, rows, total: matched, page: filters.page, pageSize: PAGE_SIZE, hasNext: truncated || matched > start + rows.length, truncated, scanned };
}

async function coverage() {
    const result = await query(`
        SELECT provider,COUNT(*)::bigint AS transactions,MIN(occurred_at) AS first_at,MAX(occurred_at) AS last_at,
               ARRAY_AGG(DISTINCT UPPER(currency) ORDER BY UPPER(currency)) AS currencies
          FROM payment_history_transactions
         GROUP BY provider
         ORDER BY provider
    `);
    return result.rows;
}

module.exports = { PAGE_SIZE, MAX_CLASSIFIED_SCAN, normalizeFilters, classify, listTransactions, coverage };
'''
(ROOT / 'src/payments/transaction-browser.js').write_text(transaction_service)

admin_transactions = r'''\
'use strict';

const express = require('express');
const browser = require('../payments/transaction-browser');
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
    if (!rows.length) return `<div class="operatorCallout warn"><strong>No provider transaction history is stored yet.</strong> Run Import history first.</div>`;
    return `<div class="operatorCallout"><strong>Imported coverage:</strong> ${rows.map(row => `${esc(providerLabel(row.provider))}: ${esc(dateTime(row.first_at))} → ${esc(dateTime(row.last_at))} · ${esc(row.transactions)} records`).join(' &nbsp; · &nbsp; ')}. <a href="/admin/payments/history">Import or refresh history</a> to extend this coverage.</div>`;
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
    </div><div class="buttonRow"><button class="button" type="submit">Apply filters</button><a class="button secondary" href="/admin/payments/transactions">Clear</a><a class="button secondary" href="/admin/payments/history">Import / refresh history</a></div></form>`;
}
function transactionRow(row, currencyState) {
    const reportCode = currencyState.currency;
    const reportMinor = reportingCurrency.convertMinor(row.gross_amount_minor, row.currency, reportCode, currencyState);
    const original = money(row.gross_amount_minor,row.currency);
    const normalized = money(reportMinor,reportCode);
    const refBits = [row.provider_transaction_id,row.provider_reference_id,row.provider_source_id].filter(Boolean);
    return `<tr>
      <td>${esc(dateTime(row.occurred_at))}</td>
      <td><strong>${esc(providerLabel(row.provider))}</strong><div class="subText">${esc(row.transaction_type || '—')}</div></td>
      <td>${kindPill(row.kind)}<div class="subText">${esc(row.transaction_status || '—')}</div></td>
      <td>${row.customer_id?`<a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing"><strong>${esc(identity(row))}</strong></a>`:`<strong>${esc(identity(row))}</strong>`}<div class="subText">${esc(row.customer_email || '')}</div></td>
      <td><strong>${esc(normalized)}</strong>${String(row.currency).toUpperCase()!==reportCode?`<div class="subText">Original ${esc(original)}</div>`:''}</td>
      <td>${esc(money(row.fee_amount_minor,row.currency))}</td>
      <td><code class="transactionId">${esc(refBits[0] || '—')}</code>${refBits.length>1?`<details><summary>More IDs</summary>${refBits.slice(1).map(v=>`<div><code class="transactionId">${esc(v)}</code></div>`).join('')}</details>`:''}</td>
    </tr>`;
}
function pagination(result) {
    const prev=result.page>1?`<a class="button secondary" href="/admin/payments/transactions?${esc(queryString(result.filters,result.page-1))}">Previous</a>`:'';
    const next=result.hasNext?`<a class="button secondary" href="/admin/payments/transactions?${esc(queryString(result.filters,result.page+1))}">Next</a>`:'';
    return `<div class="transactionPager">${prev}<span class="muted">Page ${esc(result.page)} · ${esc(result.total)} matching record${Number(result.total)===1?'':'s'}${result.truncated?' scanned so far':''}</span>${next}</div>`;
}
async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [result, coverage, currencyState] = await Promise.all([browser.listTransactions(req.query || {}), browser.coverage(), reportingCurrency.get()]);
    const warning = result.truncated ? `<div class="operatorCallout warn"><strong>Very large filtered result.</strong> Classification scanning stopped after ${esc(browser.MAX_CLASSIFIED_SCAN)} provider rows. Narrow the date/provider filters for an exact count.</div>` : '';
    const table = result.rows.length ? `<div class="tableWrap"><table class="dataTable transactionTable"><thead><tr><th>When</th><th>Provider / type</th><th>Classification / status</th><th>Customer</th><th>Amount (${esc(currencyState.currency)})</th><th>Original fee</th><th>Provider IDs</th></tr></thead><tbody>${result.rows.map(row=>transactionRow(row,currencyState)).join('')}</tbody></table></div>${pagination(result)}` : `<div class="empty">No transactions match these filters.</div>`;
    const body = `${ui.noticesFromRequest(req)}${coverageHtml(coverage)}${filterForm(result.filters)}${warning}<section class="section">${ui.sectionHeader({title:'Stripe + PayPal transactions',description:`Full imported provider ledger. Business-facing amounts are normalized to ${currencyState.currency}; original provider currency and IDs remain visible for reconciliation.`})}${table}</section><style>.transactionTable{min-width:1220px}.transactionFilters .formGrid{grid-template-columns:repeat(3,minmax(180px,1fr))}.transactionSearch{grid-column:span 2}.transactionId{font-size:10px;word-break:break-all}.transactionPager{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:12px;flex-wrap:wrap}.buttonRow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}@media(max-width:850px){.transactionFilters .formGrid{grid-template-columns:1fr}.transactionSearch{grid-column:auto}}</style>`;
    return layout({siteName:runtimeSettings.siteName(),active:'transactions',title:'Transactions',subtitle:'Every imported Stripe and PayPal provider transaction in one searchable ledger',body});
}
function createAdminTransactionsRouter() {
    const router=express.Router();
    router.use('/admin/payments/transactions',gate,noStore);
    router.get('/admin/payments/transactions',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){return next(error);}});
    return router;
}
module.exports={createAdminTransactionsRouter,page,filterForm,transactionRow};
'''
(ROOT / 'src/platform/admin-transactions.js').write_text(admin_transactions)

transaction_smoke = r'''\
'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const browser=require('../src/payments/transaction-browser');

assert.deepStrictEqual(browser.normalizeFilters({provider:'STRIPE',kind:'refund',currency:'usd',page:'2'}),{provider:'stripe',kind:'refund',currency:'USD',status:'',q:'',startDate:'',endDate:'',page:2});
assert.strictEqual(browser.classify({provider:'stripe',transaction_type:'charge',gross_amount_minor:1000}),'payment');
assert.strictEqual(browser.classify({provider:'stripe',transaction_type:'refund',gross_amount_minor:-500}),'refund');
assert.strictEqual(browser.classify({provider:'stripe',transaction_type:'payout',gross_amount_minor:-500}),'ignored');
assert.strictEqual(browser.classify({provider:'paypal',transaction_type:'T0003',transaction_status:'S',gross_amount_minor:1000}),'payment');
assert.strictEqual(browser.classify({provider:'paypal',transaction_type:'T1107',transaction_status:'S',gross_amount_minor:-500}),'refund');
assert.strictEqual(browser.classify({provider:'paypal',transaction_type:'T0003',transaction_status:'P',gross_amount_minor:1000}),'ignored');
const service=read('src/payments/transaction-browser.js');
assert(service.includes('payment_history_transactions'),'Transactions browser must use the imported provider ledger');
assert(service.includes("LEFT JOIN customers c ON c.id=t.customer_id")&&service.includes("LEFT JOIN app_users u ON u.id=c.user_id"),'Transactions browser must resolve existing customer identities without duplicating users');
assert(service.includes('historyAccounting.historyKind(row)'),'Transactions browser must reuse Payment History accounting classification');
assert(service.includes('MAX_CLASSIFIED_SCAN')&&service.includes('truncated'),'Large classified searches must surface a completeness warning instead of silently truncating');
const admin=read('src/platform/admin-transactions.js');
assert(admin.includes("/admin/payments/transactions")&&admin.includes("active:'transactions'"),'Transactions must be a first-class Payments destination');
assert(admin.includes('reportingCurrency.convertMinor'),'Visible transaction amounts must normalize into the configured portal currency');
assert(admin.includes('Original')&&admin.includes('/admin/payments/history'),'Original currency must remain visible and history coverage must be refreshable');
const routes=read('src/platform/admin-route-composition.js');
assert(routes.includes('createAdminTransactionsRouter')&&routes.includes('app.use(createAdminTransactionsRouter())'),'Transactions router must be mounted canonically');
const nav=require('../src/platform/admin-nav');
assert(nav.childPages('payments').some(page=>page[0]==='transactions'&&page[2]==='/admin/payments/transactions'),'Transactions must be reachable from Payments & Billing sidebar');
console.log('transaction browser smoke: ok');
'''
(ROOT / 'scripts/transaction-browser-smoke.js').write_text(transaction_smoke)

# Canonical route composition.
replace_once(
    'src/platform/admin-route-composition.js',
    "const { createAdminPaymentHistoryRouter } = require('./admin-payment-history');\n",
    "const { createAdminPaymentHistoryRouter } = require('./admin-payment-history');\nconst { createAdminTransactionsRouter } = require('./admin-transactions');\n"
)
replace_once(
    'src/platform/admin-route-composition.js',
    "  app.use(createAdminPaymentHistoryRouter());\n",
    "  app.use(createAdminPaymentHistoryRouter());\n  app.use(createAdminTransactionsRouter());\n"
)

# Sidebar destination directly under Payments & Billing.
replace_once(
    'src/platform/admin-nav.js',
    "  billing:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),\n  expenses:Object.freeze",
    "  billing:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),\n  transactions:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['transactions','Transactions','/admin/payments/transactions'])}),\n  expenses:Object.freeze"
)

# Navigation regressions.
replace_once(
    'scripts/admin-navigation-coherence-smoke.js',
    "['Billing','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']",
    "['Billing','Transactions','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']"
)
replace_once(
    'scripts/admin-navigation-coherence-smoke.js',
    "assert.strictEqual(nav.sidebarKey('expenses'),'payments');\n",
    "assert.strictEqual(nav.sidebarKey('expenses'),'payments');\nassert.strictEqual(nav.sidebarKey('transactions'),'payments');\n"
)
replace_once(
    'scripts/admin-navigation-coherence-smoke.js',
    "assert(expenseHeader.includes('href=\"/admin/billing\"')&&expenseHeader.includes('href=\"/admin/provider-mappings\"')",
    "assert(expenseHeader.includes('href=\"/admin/billing\"')&&expenseHeader.includes('href=\"/admin/payments/transactions\"')&&expenseHeader.includes('href=\"/admin/provider-mappings\"')"
)
replace_once(
    'scripts/admin-navigation-coherence-smoke.js',
    "assert(rendered.includes('href=\"/admin/payments/history\"'),'Payment History must be reachable from the canonical sidebar');\n",
    "assert(rendered.includes('href=\"/admin/payments/history\"'),'Payment History must be reachable from the canonical sidebar');\nassert(rendered.includes('href=\"/admin/payments/transactions\"'),'Transactions must be reachable from the canonical sidebar');\n"
)

replace_once(
    'scripts/customer-bot-commerce-smoke.js',
    "for(const title of ['Payments','Provider mappings','Billing','Payment Risk Policy','Payment History','Migrate paid users'])",
    "for(const title of ['Payments','Provider mappings','Billing','Transactions','Payment Risk Policy','Payment History','Migrate paid users'])"
)
replace_once(
    'scripts/customer-bot-commerce-smoke.js',
    "['Billing','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']",
    "['Billing','Transactions','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']"
)

# Put both regressions in the normal fast suite without rewriting unrelated scripts.
replace_once(
    'package.json',
    "node scripts/payment-history-import-smoke.js && node scripts/legacy-customer-import-smoke.js && node scripts/plisio-payments-smoke.js",
    "node scripts/payment-history-import-smoke.js && node scripts/legacy-customer-import-smoke.js && node scripts/subscription-discovery-smoke.js && node scripts/transaction-browser-smoke.js && node scripts/plisio-payments-smoke.js"
)
