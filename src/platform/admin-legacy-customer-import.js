'use strict';

const moneyFormat=require('./money-format');

const express = require('express');
const csrf = require('../auth/csrf');
const legacyImport = require('../payments/legacy-customer-import');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');

function gate(req, res, next) { return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId ? next() : res.redirect('/login?session=expired'); }
function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store, private, max-age=0'); res.setHeader('Pragma', 'no-cache'); next(); }
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function money(minor,currency){return moneyFormat.formatMinor(minor,currency||'USD');}
function when(value) { const d = value instanceof Date ? value : new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }); }
function provider(value) { return value === 'paypal' ? 'PayPal' : value === 'stripe' ? 'Stripe' : value === 'manual' ? 'Manual' : String(value || '—'); }
function stateLabel(state) { return ({ ready_current: 'Activate now', ready_future: 'Schedule', covered: 'Already covered', already_imported: 'Already imported', review: 'Review', expired: 'Expired', excluded: 'Excluded' })[state] || state; }
function stateClass(state) { return ['ready_current','ready_future'].includes(state) ? 'good' : state === 'review' ? 'bad' : ['covered','already_imported'].includes(state) ? 'accent' : ''; }

function uploadForm(req) {
  return `<section class="section"><div class="sectionHead"><div><h2>Migrate paid users</h2><div class="muted">Restore existing paid terms from the old portal's Users and Payments CSV exports.</div></div><div class="buttonRow"><a class="button secondary btn-sm" href="/admin/payments/export">Export data</a><a class="button secondary btn-sm" href="/admin/provider-mappings">Provider mappings</a></div></div>
    <div class="operatorCallout"><strong>This is the migration screen you want.</strong> Provider mappings configure prices for future checkout; they are not required to restore a trusted legacy customer's remaining paid term.</div>
    <div class="operatorCallout warn"><strong>No charge is created.</strong> CAPTAiNFiN reads the original email, plan, amount, processor and From/To dates. Expired terms and trials are ignored. A real Stripe/PayPal recurring subscription is linked separately from verified provider state.</div>
    <form class="formPanel" method="post" action="/admin/payments/legacy-import/preview" data-legacy-import-form>
      ${csrfInput(req)}<input type="hidden" name="payload" value="">
      <div class="formGroup"><label>Legacy CSV exports</label><input class="input" type="file" accept=".csv,text/csv" multiple required data-legacy-files><div class="inlineHelp">Select all relevant Users*.csv and Payments*.csv files together. Up to ${legacyImport.MAX_FILES} files / 650 KB combined.</div><div class="inlineHelp" data-legacy-file-status></div></div>
      <div class="buttonRow"><button class="button">Preview paid-user migration</button><a class="button secondary" href="/admin/payments">Cancel</a></div>
    </form>
  </section><script src="/js/admin-legacy-customer-import.js" defer></script>`;
}

function metrics(counts) {
  if (!counts) return '';
  return `<div class="metrics">
    <div class="metric"><div class="metricLabel">Payment rows</div><div class="metricValue">${esc(counts.paymentRows)}</div></div>
    <div class="metric"><div class="metricLabel">Safe to restore</div><div class="metricValue">${esc(counts.ready)}</div><div class="subText">${esc(counts.current)} now · ${esc(counts.future)} future${Number(counts.extend || 0) ? ` · ${esc(counts.extend)} extension${Number(counts.extend) === 1 ? '' : 's'}` : ''}</div></div>
    <div class="metric"><div class="metricLabel">Already covered/imported</div><div class="metricValue">${esc(counts.covered + counts.imported)}</div></div>
    <div class="metric"><div class="metricLabel">Needs review</div><div class="metricValue">${esc(counts.review)}</div><div class="subText">${esc(counts.expired + counts.excluded)} expired/trial excluded</div></div>
  </div>`;
}

function planMappings(result) {
  const grouped = new Map();
  for (const row of result?.candidates || []) {
    if (!row.plan?.name) continue;
    const key = row.plan.name;
    if (!grouped.has(key)) grouped.set(key, { legacy: key, plan: row.planMatch?.name || null, code: row.planMatch?.code || null, legacyStreams: row.plan.streams, currentStreams: row.planMatch?.streams, override: row.streamOverride, count: 0, unresolved: !row.planMatch });
    grouped.get(key).count++;
  }
  const rows = [...grouped.values()].sort((a,b) => a.legacy.localeCompare(b.legacy));
  if (!rows.length) return '';
  return `<section class="section"><div class="sectionHead"><div><h2>Plan mapping</h2><div class="muted">Legacy names are mapped by billing term and stream allowance. Legacy commercial terms are snapshotted; the current storefront price is not substituted.</div></div></div><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Legacy plan</th><th>Rows</th><th>Current CAPTAiNFiN plan</th><th>Streams</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${esc(row.legacy)}</strong></td><td>${esc(row.count)}</td><td>${row.plan ? `<strong>${esc(row.plan)}</strong><div class="subText">${esc(row.code || '')}</div>` : '<span class="pill bad">Needs mapping</span>'}</td><td>${row.legacyStreams ? `${esc(row.legacyStreams)} legacy${row.override ? ` <span class="pill warn">preserved override</span>` : ''}` : 'Plan default'}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function candidateRows(result) {
  const important = (result?.candidates || []).filter(row => !['expired','excluded'].includes(row.state));
  if (!important.length) return '<div class="empty">No current or future paid terms were found.</div>';
  return `<div class="tableWrap"><table class="dataTable responsiveTable legacyMigrationTable"><thead><tr><th>Customer</th><th>Legacy plan</th><th>Processor</th><th>Paid</th><th>Term</th><th>Outcome</th></tr></thead><tbody>${important.slice(0,250).map(row => `<tr><td><strong>${esc(row.email)}</strong><div class="subText">${row.customer ? (row.customerMatch === 'jellyfin_username' ? 'Matched existing managed Jellyfin user' : 'Existing CAPTAiNFiN customer') : row.createCustomer ? (row.linkUserId ? 'Will attach existing portal login; Jellyfin link still required' : 'Will create imported customer record; Jellyfin link still required') : ''}</div></td><td>${esc(row.plan?.name || '—')}${row.planMatch ? `<div class="subText">→ ${esc(row.planMatch.name)}${row.streamOverride ? ` · keep ${esc(row.plan.streams)} streams` : ''}</div>` : ''}</td><td>${esc(provider(row.provider))}<div class="subText"><code>${esc(row.transactionId || '—')}</code></div></td><td>${row.money ? esc(money(row.money.minor,row.money.currency)) : '—'}</td><td>${esc(when(row.start))}<div class="subText">to ${esc(when(row.end))}</div></td><td><span class="pill ${stateClass(row.state)}">${esc(row.extendSubscriptionId ? 'Extend existing access' : stateLabel(row.state))}</span><div class="subText">${esc(row.reason || '')}</div></td></tr>`).join('')}</tbody></table></div>${important.length>250?`<div class="muted">Showing the first 250 of ${esc(important.length)} non-expired rows.</div>`:''}`;
}

function previewBody(req, result, encodedPayload, importedResult = null) {
  const canApply = Number(result?.counts?.ready || 0) > 0;
  const done = importedResult ? `<div class="notice success"><strong>Legacy paid-user migration completed.</strong> ${esc(importedResult.imported.length)} subscription term(s) were restored${Number(importedResult.extendedSubscriptions || 0) ? `, including ${esc(importedResult.extendedSubscriptions)} safe extension${Number(importedResult.extendedSubscriptions) === 1 ? '' : 's'} of existing local paid access` : ''}, ${esc(importedResult.createdCustomers)} customer record(s) were created, and ${esc(importedResult.provisionedCustomers)} current customer(s) with an already-linked Jellyfin identity were sent through access reconciliation.${Number(importedResult.pendingJellyfinLinks || 0) ? ` <strong>${esc(importedResult.pendingJellyfinLinks)} current customer(s) still need their existing Jellyfin identity linked; CAPTAiNFiN deliberately did not create a duplicate Jellyfin user.</strong>` : ''}</div>` : '';
  const unknown = result?.unknownFiles?.length ? `<div class="notice warn">Ignored unrecognised CSV file(s): ${result.unknownFiles.map(esc).join(', ')}</div>` : '';
  return `${done}${unknown}${metrics(result.counts)}${planMappings(result)}<section class="section"><div class="sectionHead"><div><h2>${importedResult?'Migration result':'Migration preview'}</h2><div class="muted">Only green current/future rows are eligible. Existing provider-managed access is never overwritten.</div></div><a class="button secondary btn-sm" href="/admin/payments/legacy-import">Choose different files</a></div>${candidateRows(result)}${!importedResult && canApply ? `<form class="formPanel" method="post" action="/admin/payments/legacy-import/apply" style="margin-top:16px">${csrfInput(req)}<input type="hidden" name="payload" value="${esc(encodedPayload)}"><label class="checkRow"><input type="checkbox" name="confirm" value="1" required><span>I understand this will create/restore local customer access from these trusted legacy portal exports. It does not charge customers.</span></label><div class="operatorCallout warn"><strong>Before applying:</strong> ${esc(result.counts.ready)} safe paid term(s) will be restored. Rows marked Review are not touched.</div><button class="button">Import & activate safe users</button></form>` : !importedResult ? '<div class="operatorCallout warn">Nothing is currently safe to apply. Resolve the rows marked Review first.</div>' : ''}</section>`;
}

async function page(req, options = {}) {
  await runtimeSettings.ensureLoaded();
  const body = `${options.error ? `<div class="notice error"><strong>Migration stopped:</strong> ${esc(options.error)}</div>` : ''}${options.result ? previewBody(req, options.result, options.payload, options.importedResult) : uploadForm(req)}`;
  return layout({ siteName: runtimeSettings.siteName(), active: 'legacy-paid-import', title: 'Migrate paid users', subtitle: 'Restore trusted legacy customer subscriptions without creating a new payment', body });
}

function createAdminLegacyCustomerImportRouter() {
  const router = express.Router();
  router.use('/admin/payments/legacy-import', gate, noStore);
  router.get('/admin/payments/legacy-import', async (req,res,next) => { try { return res.send(await page(req)); } catch (error) { return next(error); } });
  router.post('/admin/payments/legacy-import/preview', async (req,res,next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const files = legacyImport.decodePayload(req.body?.payload);
      const result = await legacyImport.preview(files);
      const payload = legacyImport.encodePayload(files);
      return res.send(await page(req, { result, payload }));
    } catch (error) {
      try { return res.status(400).send(await page(req, { error: error.message || String(error) })); } catch (renderError) { return next(renderError); }
    }
  });
  router.post('/admin/payments/legacy-import/apply', async (req,res,next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    if (req.body?.confirm !== '1') return res.status(400).send(await page(req, { error: 'Tick the confirmation box before restoring legacy paid access.' }));
    try {
      const files = legacyImport.decodePayload(req.body?.payload);
      const importedResult = await legacyImport.importSafe(files, req.session.authUserId);
      const payload = legacyImport.encodePayload(files);
      return res.send(await page(req, { result: importedResult, importedResult, payload }));
    } catch (error) {
      try { return res.status(400).send(await page(req, { error: error.message || String(error) })); } catch (renderError) { return next(renderError); }
    }
  });
  return router;
}

module.exports = { createAdminLegacyCustomerImportRouter, page, uploadForm, previewBody };
