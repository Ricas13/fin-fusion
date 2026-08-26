'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const dataExport = require('../payments/data-export');
const reportingCurrency = require('./reporting-currency');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');

function gate(req,res,next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req,res,next) {
    res.setHeader('Cache-Control','no-store, private, max-age=0');
    res.setHeader('Pragma','no-cache');
    next();
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function dateTag(value = new Date()) { return value.toISOString().slice(0,10); }
function fileName(kind, ext = 'csv') { return `captainfin-${kind}-${dateTag()}.${ext}`; }
function sendDownload(res, name, contentType, content) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content),'utf8');
    res.status(200);
    res.setHeader('Content-Type',contentType);
    res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
    res.setHeader('Content-Length',String(body.length));
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store, private, max-age=0');
    return res.send(body);
}
function exportCard(req,{title,description,action,label,count,detail}) {
    return `<article class="exportCard"><div><h2>${esc(title)}</h2><p>${esc(description)}</p>${detail?`<div class="inlineHelp">${esc(detail)}</div>`:''}</div><div class="exportCardFoot"><span class="pill">${esc(count)} record${Number(count)===1?'':'s'}</span><form method="post" action="${esc(action)}">${csrfInput(req)}<button class="button" type="submit">${esc(label)}</button></form></div></article>`;
}

async function page(req, options = {}) {
    await runtimeSettings.ensureLoaded();
    const counts = options.counts || await dataExport.summary();
    const body = `${options.error?`<div class="notice error"><strong>Export stopped:</strong> ${esc(options.error)}</div>`:''}
      <div class="operatorCallout"><strong>Portable exports, not a secrets backup.</strong> These files contain customer/subscription/accounting records only. Passwords, sessions, API keys, payment-provider credentials, Jellyfin tokens and encrypted secret blobs are never selected.</div>
      <div class="operatorCallout warn"><strong>Round-trip rule:</strong> unzip the migration bundle and select <code>Users.csv</code> + <code>Payments.csv</code> in <a href="/admin/payments/legacy-import">Migrate paid users</a>. Real Stripe/PayPal recurring IDs are exported as audit metadata but are not blindly trusted on restore; use Billing discovery to verify and re-link them.</div>
      <section class="exportGrid">
        ${exportCard(req,{title:'Users.csv',description:'Customer identity and access metadata in the same shape accepted by the legacy Users importer.',action:'/admin/payments/export/users',label:'Download users',count:counts.customers,detail:'Includes email, portable name, expiration, portal username and managed Jellyfin usernames.'})}
        ${exportCard(req,{title:'Payments.csv',description:'Current and future paid subscription terms, formatted so CAPTAiNFiN can restore them through Migrate paid users.',action:'/admin/payments/export/payments',label:'Download payments',count:counts.portablePayments,detail:'Preserves paid term, price, stream allowance, original source and provider IDs as metadata. No charge is created by restoring it.'})}
        ${exportCard(req,{title:'Transactions.csv',description:'The complete imported Stripe + PayPal accounting ledger, including payments, refunds and provider movements.',action:'/admin/payments/export/transactions',label:'Download transactions',count:counts.transactions,detail:'Includes original amounts/currency, provider IDs, customer matches and the configured reporting-currency gross amount.'})}
        ${exportCard(req,{title:'Migration bundle.zip',description:'One portable archive containing Users.csv, Payments.csv, Transactions.csv, manifest.json and restore instructions.',action:'/admin/payments/export/bundle',label:'Download bundle',count:counts.customers+counts.portablePayments+counts.transactions,detail:'Use this for moving or preserving the business dataset without exporting credentials or authentication secrets.'})}
      </section>
      <section class="section"><h2>What this does not export</h2><div class="muted">Administrator/customer passwords · password hashes · sessions/cookies · API keys · Stripe restricted/secret keys · PayPal client secrets · Jellyfin API/access tokens · encryption keys · TOTP secrets · reset/verification tokens.</div></section>
      <style>.exportGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.exportCard{display:flex;flex-direction:column;justify-content:space-between;gap:18px;border:1px solid var(--line,#2b3947);border-radius:12px;padding:18px;background:var(--panel,#101820);min-width:0}.exportCard h2{margin:0 0 6px}.exportCard p{margin:0;color:var(--muted,#9aabba);line-height:1.5}.exportCardFoot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.exportCardFoot form{margin:0}@media(max-width:760px){.exportGrid{grid-template-columns:1fr}.exportCard{padding:14px}.exportCardFoot{display:grid;grid-template-columns:1fr}.exportCardFoot .button{width:100%;justify-content:center}.operatorCallout{overflow-wrap:anywhere}}</style>`;
    return layout({siteName:runtimeSettings.siteName(),active:'data-export',title:'Export data',subtitle:'Download portable customer, subscription and Stripe/PayPal accounting data',body});
}

async function transactionCsv() {
    const [rows,state] = await Promise.all([dataExport.loadTransactions(),reportingCurrency.get()]);
    return { rows, content: dataExport.transactionsCsv(rows,{reportingCurrency:state.currency,convertMinor:reportingCurrency.convertMinor,currencyState:state}) };
}
async function bundleFiles() {
    const [users,payments,transactions,state] = await Promise.all([dataExport.loadUsers(),dataExport.loadPortablePayments(),dataExport.loadTransactions(),reportingCurrency.get()]);
    const usersText = dataExport.usersCsv(users);
    const paymentsText = dataExport.paymentsCsv(payments);
    const transactionsText = dataExport.transactionsCsv(transactions,{reportingCurrency:state.currency,convertMinor:reportingCurrency.convertMinor,currencyState:state});
    const generatedAt = new Date();
    const manifest = {
        format: 'captainfin-portable-export-v1',
        generatedAt: generatedAt.toISOString(),
        reportingCurrency: state.currency,
        counts: { users: users.length, payments: payments.length, transactions: transactions.length },
        restore: { importer: '/admin/payments/legacy-import', files: ['Users.csv','Payments.csv'], providerRelink: '/admin/billing' },
        secretsIncluded: false
    };
    const readme = `CAPTAiNFiN portable migration bundle\nGenerated: ${generatedAt.toISOString()}\n\nRESTORE\n1. Open Commerce -> Payments & Billing -> Migrate paid users.\n2. Select Users.csv and Payments.csv together and preview the migration.\n3. Apply only the safe matches.\n4. Open Billing -> Discover current subscriptions to verify/re-link genuine Stripe/PayPal recurring IDs.\n5. Transactions.csv is accounting history and is not entitlement-authoritative.\n\nSECURITY\nThis archive deliberately excludes passwords, password hashes, sessions, API keys, payment-provider credentials, Jellyfin tokens, encryption keys, TOTP secrets and verification/reset tokens.\n`;
    return { users,payments,transactions, generatedAt, files:[
        {name:'Users.csv',data:usersText},
        {name:'Payments.csv',data:paymentsText},
        {name:'Transactions.csv',data:transactionsText},
        {name:'manifest.json',data:JSON.stringify(manifest,null,2)+'\n'},
        {name:'README.txt',data:readme}
    ] };
}

function createAdminDataExportRouter() {
    const router = express.Router();
    router.use('/admin/payments/export',gate,noStore);
    router.get('/admin/payments/export',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){return next(error);}});
    router.post('/admin/payments/export/users',async(req,res,next)=>{
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const rows=await dataExport.loadUsers(); const content=dataExport.usersCsv(rows); await dataExport.auditExport(req.session.authUserId,'users',{rows:rows.length}); return sendDownload(res,fileName('users'),'text/csv; charset=utf-8',content); } catch(error){ return next(error); }
    });
    router.post('/admin/payments/export/payments',async(req,res,next)=>{
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const rows=await dataExport.loadPortablePayments(); const content=dataExport.paymentsCsv(rows); await dataExport.auditExport(req.session.authUserId,'payments',{rows:rows.length}); return sendDownload(res,fileName('payments'),'text/csv; charset=utf-8',content); } catch(error){ return next(error); }
    });
    router.post('/admin/payments/export/transactions',async(req,res,next)=>{
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const result=await transactionCsv(); await dataExport.auditExport(req.session.authUserId,'transactions',{rows:result.rows.length}); return sendDownload(res,fileName('transactions'),'text/csv; charset=utf-8',result.content); } catch(error){ return next(error); }
    });
    router.post('/admin/payments/export/bundle',async(req,res,next)=>{
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try { const result=await bundleFiles(); const archive=dataExport.zipStore(result.files,result.generatedAt); await dataExport.auditExport(req.session.authUserId,'migration_bundle',{users:result.users.length,payments:result.payments.length,transactions:result.transactions.length}); return sendDownload(res,fileName('migration-bundle','zip'),'application/zip',archive); } catch(error){ return next(error); }
    });
    return router;
}

module.exports = { createAdminDataExportRouter,page,sendDownload,transactionCsv,bundleFiles };
