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
      <div class="operatorCallout"><strong>CSV exports, not a secrets backup.</strong> These files contain customer, subscription and accounting records only. Passwords, sessions, API keys, payment-provider credentials, Jellyfin tokens and encrypted secret blobs are never selected.</div>
      <section class="exportGrid">
        ${exportCard(req,{title:'Users.csv',description:'Customer identity and current access metadata.',action:'/admin/payments/export/users',label:'Download users',count:counts.customers,detail:'Includes email, display identity, expiration, portal username and managed Jellyfin usernames.'})}
        ${exportCard(req,{title:'Payments.csv',description:'Current and future paid subscription terms with billing and provider metadata.',action:'/admin/payments/export/payments',label:'Download payments',count:counts.portablePayments,detail:'Includes paid term, price, stream allowance, source and provider identifiers where available.'})}
        ${exportCard(req,{title:'Transactions.csv',description:'The stored Stripe + PayPal accounting ledger, including payments, refunds and provider movements.',action:'/admin/payments/export/transactions',label:'Download transactions',count:counts.transactions,detail:'Includes original amounts/currency, provider IDs, customer matches and the configured reporting-currency gross amount.'})}
      </section>
      <section class="section"><h2>What this does not export</h2><div class="muted">Administrator/customer passwords · password hashes · sessions/cookies · API keys · Stripe restricted/secret keys · PayPal client secrets · Jellyfin API/access tokens · encryption keys · TOTP secrets · reset/verification tokens.</div></section>
      <style>.exportGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}.exportCard{display:flex;flex-direction:column;justify-content:space-between;gap:18px;border:1px solid var(--line,#2b3947);border-radius:12px;padding:18px;background:var(--panel,#101820);min-width:0}.exportCard h2{margin:0 0 6px}.exportCard p{margin:0;color:var(--muted,#9aabba);line-height:1.5}.exportCardFoot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.exportCardFoot form{margin:0}@media(max-width:1100px){.exportGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.exportGrid{grid-template-columns:1fr}.exportCard{padding:14px}.exportCardFoot{display:grid;grid-template-columns:1fr}.exportCardFoot .button{width:100%;justify-content:center}.operatorCallout{overflow-wrap:anywhere}}</style>`;
    return layout({siteName:runtimeSettings.siteName(),active:'data-export',title:'Export data',subtitle:'Download customer, subscription and Stripe/PayPal accounting CSV files',body});
}

async function transactionCsv() {
    const [rows,state] = await Promise.all([dataExport.loadTransactions(),reportingCurrency.get()]);
    return { rows, content: dataExport.transactionsCsv(rows,{reportingCurrency:state.currency,convertMinor:reportingCurrency.convertMinor,currencyState:state}) };
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
    return router;
}

module.exports = { createAdminDataExportRouter,page,sendDownload,transactionCsv };
