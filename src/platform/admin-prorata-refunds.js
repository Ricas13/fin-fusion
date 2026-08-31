'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const refunds = require('../payments/prorata-refunds');
const routeRateLimit = require('../security/route-rate-limit');
const runtimeSettings = require('./runtime-settings');
const ui = require('./admin-ui');
const { esc, layout } = require('./admin-html');

const refundRouteLimit = routeRateLimit.middleware({
  scope: 'admin-prorata-refunds',
  max: 120,
  windowSeconds: 60,
  reason: 'admin_prorata_refund'
});

function gate(req, res, next) {
  if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  return next();
}
function money(minor, currency) {
  const code = String(currency || 'GBP').toUpperCase();
  try { return new Intl.NumberFormat('en-GB', { style:'currency', currency:code, currencyDisplay:'narrowSymbol' }).format(Number(minor || 0) / 100); }
  catch { return `${code} ${(Number(minor || 0) / 100).toFixed(2)}`; }
}
function when(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' });
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function cleanCustomerId(value) { const v=String(value||'').trim(); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)?v:null; }

async function eligibleRows(customerId=null) {
  const id=cleanCustomerId(customerId);
  const result = await query(`
    SELECT s.id,s.customer_id,s.source,s.provider_subscription_id,s.status,s.starts_at,s.current_period_end,
           s.plan_name_snapshot,s.currency_snapshot,c.display_name,c.email,u.username AS portal_username
    FROM subscriptions s
    JOIN customers c ON c.id=s.customer_id
    LEFT JOIN app_users u ON u.id=c.user_id
    WHERE s.superseded_by IS NULL
      AND ($1::uuid IS NULL OR s.customer_id=$1::uuid)
      AND s.source IN ('stripe','paypal')
      AND s.status IN ('active','trialing','past_due','paused','cancelled')
      AND s.current_period_end>NOW()
      AND NOT (s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_')
      AND NOT (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-')
    ORDER BY s.starts_at,c.display_name,s.created_at
    LIMIT 250
  `,[id]);
  return result.rows;
}

async function listPage(req) {
  await runtimeSettings.ensureLoaded();
  const customerId=cleanCustomerId(req.query.customerId),rows=await eligibleRows(customerId);
  const bodyRows = rows.map(row => `<tr>
    <td data-label="Customer"><a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing"><strong>${esc(row.portal_username || row.display_name || row.email || 'Customer')}</strong></a><div class="subText">${esc(row.email || '')}</div></td>
    <td data-label="Plan"><strong>${esc(row.plan_name_snapshot || 'Prepaid plan')}</strong><div class="subText">${esc(String(row.source).toUpperCase())}</div></td>
    <td data-label="Service period">${esc(when(row.starts_at))}<div class="subText">to ${esc(when(row.current_period_end))}</div></td>
    <td data-label="State">${esc(row.status)}</td>
    <td data-label="Action" class="right"><a class="button secondary btn-sm" href="/admin/refunds/${encodeURIComponent(row.id)}">Preview refund</a></td>
  </tr>`).join('');
  const table = rows.length
    ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Plan</th><th>Service period</th><th>State</th><th class="right">Action</th></tr></thead><tbody>${bodyRows}</tbody></table></div>`
    : `<div class="empty">${customerId?'This customer has no Stripe or PayPal prepaid purchase with refundable unused service.':'No Stripe or PayPal prepaid purchases currently have refundable unused service.'}</div>`;
  const back=customerId?`<a class="button secondary btn-sm" href="/admin/users/${encodeURIComponent(customerId)}?tab=billing">Back to customer billing</a>`:'';
  const body = `${ui.noticesFromRequest(req)}<section class="section">${ui.sectionHeader({title:'Prepaid refund',description:customerId?'Customer-specific unused-time refund workflow.':'Specialist unused-time refund workflow; normally opened from a customer Billing page.'})}<div class="sectionHead"><div class="operatorCallout"><strong>Cash-only rule:</strong> affiliate/service credit is never converted back into cash. The final amount is recalculated under a database lock when you confirm.</div>${back}</div>${table}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'refunds',title:'Prepaid refund',subtitle:'Unused-time refund quotes and execution',body});
}

async function previewPage(req, subscriptionId) {
  await runtimeSettings.ensureLoaded();
  const quote = await refunds.quote(subscriptionId);
  const unusedPercent = Math.max(0, Math.min(100, quote.unusedFraction * 100));
  const customer = (await query(`SELECT c.display_name,c.email,u.username FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`, [quote.customerId])).rows[0] || {};
  const identity = customer.username || customer.display_name || customer.email || 'Customer';
  const serviceCredit = quote.serviceCreditMinor > 0 ? `<div class="operatorCallout warn"><strong>Service credit used:</strong> ${esc(money(quote.serviceCreditMinor, quote.currency))}. It is not included in the cash refund and will not be paid out.</div>` : '';
  const body = `${ui.noticesFromRequest(req)}<section class="section">${ui.sectionHeader({title:'Refund preview',description:`${identity} · ${quote.planName}`})}
    <div class="metrics">
      <div class="metric"><div class="metricLabel">Provider cash paid</div><div class="metricValue">${esc(money(quote.providerPaidMinor, quote.currency))}</div></div>
      <div class="metric"><div class="metricLabel">Already refunded</div><div class="metricValue">${esc(money(quote.alreadyRefundedMinor, quote.currency))}</div></div>
      <div class="metric"><div class="metricLabel">Unused service</div><div class="metricValue">${esc(unusedPercent.toFixed(1))}%</div></div>
      <div class="metric"><div class="metricLabel">Maximum cash refund</div><div class="metricValue">${esc(money(quote.refundMinor, quote.currency))}</div></div>
    </div>
    ${serviceCredit}
    <div class="operatorCallout"><strong>Current service:</strong> ${esc(when(quote.startsAt))} → ${esc(when(quote.originalEnd))}.<br><strong>After this refund:</strong> this purchased period ends at ${esc(when(quote.cutoffAt))}; any later queued prepaid periods are pulled forward by the removed unused span.</div>
    <form class="formPanel" method="post" action="/admin/refunds/${encodeURIComponent(subscriptionId)}" data-confirm="Refund ${esc(money(quote.refundMinor, quote.currency))} through ${esc(String(quote.provider).toUpperCase())} and remove the corresponding unused prepaid time?">
      ${csrfInput(req)}
      <div class="formGroup"><label>Reason</label><textarea class="input" name="reason" maxlength="500" required placeholder="Customer requested refund of unused prepaid service"></textarea></div>
      <div class="buttonRow"><button class="button danger" type="submit">Refund unused time</button><a class="button secondary" href="/admin/users/${encodeURIComponent(quote.customerId)}?tab=billing">Cancel</a></div>
    </form>
  </section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'refunds',title:'Refund preview',subtitle:'Provider cash only · recalculated on confirmation',body});
}

function createAdminProrataRefundsRouter() {
  const router = express.Router();
  router.use('/admin/refunds', refundRouteLimit, gate, noStore);
  router.get('/admin/refunds', async (req,res,next) => { try { return res.send(await listPage(req)); } catch (error) { return next(error); } });
  router.get('/admin/refunds/:subscriptionId', async (req,res,next) => { try { return res.send(await previewPage(req, req.params.subscriptionId)); } catch (error) { return next(error); } });
  router.post('/admin/refunds/:subscriptionId', csrf.requireCsrf, async (req,res,next) => {
    try {
      const result = await refunds.execute({ subscriptionId:req.params.subscriptionId, actorUserId:req.session.authUserId, reason:req.body.reason });
      const message = result.alreadyCompleted ? 'That refund was already completed.' : `Refund completed: ${money(result.quote.refundMinor, result.quote.currency)} returned through ${String(result.quote.provider).toUpperCase()}.`;
      return res.redirect(`/admin/users/${encodeURIComponent(result.quote.customerId)}?tab=billing&message=${encodeURIComponent(message)}`);
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { createAdminProrataRefundsRouter, eligibleRows, listPage, previewPage, cleanCustomerId };
