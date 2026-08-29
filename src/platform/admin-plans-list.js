'use strict';

const express = require('express');
const { query } = require('../db');
const { esc, layout } = require('./admin-html');
const { listData } = require('./admin-plans');
const runtimeSettings = require('./runtime-settings');
const readiness = require('./product-readiness');
const planComponents = require('../access/plan-components');
const capacity = require('../entitlements/plan-capacity');
const ui = require('./admin-ui');

function gate(req, res, next) {
  return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId
    ? next()
    : res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function notice(req) {
  return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function durationLabel(plan) {
  const days = Math.max(1, Number(plan?.duration_days || 1));
  return ({ trial: days === 1 ? '24 hours' : `${days} days`, month: '1 month', '6_months': '6 months', year: '1 year' })[plan?.billing_interval] || (days === 1 ? '1 day' : `${days} days`);
}
function priceLabel(plan) {
  const minor = Number(plan?.price_minor || 0);
  return minor === 0 ? 'Free' : `${String(plan?.currency || '').toUpperCase()} ${(minor / 100).toFixed(2)}`.trim();
}
function billingLabel(value) {
  return ({ trial: 'Trial', month: 'Monthly', '6_months': '6 months', year: 'Yearly', custom: 'Custom' })[value] || 'Custom';
}
function state(plan) { return readiness.catalogueState(plan); }
function serviceLabel(plan) {
  return ({ jellyfin: 'Jellyfin', stremio: 'Stremio', bundle: 'Legacy bundle' })[readiness.serviceType(plan)] || 'Jellyfin';
}
function accessModel(plan) { return planComponents.accessLabel(plan) || 'Access not configured'; }
function productTabs() { return ''; }
function planFamily(plan) {
  const service = readiness.serviceType(plan), audience = String(plan.audience || 'direct');
  if (plan.is_addon || service === 'bundle') return 'legacy';
  if (audience === 'reseller') return 'reseller';
  if (service === 'stremio') return 'stremio';
  if (service === 'jellyfin' && (plan.is_free_tier || (Number(plan.price_minor || 0) === 0 && String(plan.billing_interval || '') !== 'trial'))) return 'free';
  return 'paid';
}
function familyMatches(plan, type) {
  if (!type) return true;
  const family = planFamily(plan), service = readiness.serviceType(plan);
  if (type === 'jellyfin') return family === 'free' || family === 'paid';
  if (type === 'stremio') return family === 'stremio';
  return family === type || service === type;
}
function capacityCell(plan) {
  const link = `/admin/plans/${encodeURIComponent(plan.id)}/inventory`,state=plan.capacity_state||{};
  if(state.model==='fleet_streams'){
    const used=Math.max(0,Number(state.streamUsed||0)),held=Math.max(0,Number(state.streamReserved||0)),occupied=used+held,limit=Math.max(0,Number(state.streamLimit||0)),pct=limit?Math.min(100,Math.round((occupied/limit)*100)):100,near=pct>=85?' nearFull':'';
    return `<div class="capacityMeter"><strong class="${state.soldOut?'statusBad':Number(state.remaining)<=10?'statusWarn':'statusGood'}">${esc(state.label||`${state.remaining} available`)}</strong><div class="subText">${used} occupying · ${held} held · ${limit} sellable · ${esc(state.requiredStreams)} per new customer</div><div class="capacityMeterLine"><span class="capacityMeterFill${near}" style="width:${pct}%"></span></div><a class="subText" href="${esc(link)}">View shared ${esc(state.pool)} capacity →</a></div>`;
  }
  const limit=state.limit==null?null:Number(state.limit),used=Number(state.used||0)+Number(state.reserved||0);
  if(limit==null)return `<span class="statusPill statusWarn">Inventory not configured</span><div class="subText">${used} active/held · legacy unlimited state</div><a class="subText" href="${esc(link)}">Set inventory →</a>`;
  if(limit===0)return `<div class="capacityMeter"><strong class="statusBad">Closed · 0 available</strong><div class="subText">${Number(plan.live_subscriber_count||0)?`${Number(plan.live_subscriber_count||0)} existing active subscription${Number(plan.live_subscriber_count||0)===1?'':'s'} unaffected`:'No new acquisition'}</div><div class="capacityMeterLine"><span class="capacityMeterFill nearFull" style="width:100%"></span></div><a class="subText" href="${esc(link)}">Open availability →</a></div>`;
  const remaining=Math.max(0,Number(state.remaining||0)),pct=Math.min(100,Math.round((used/limit)*100)),near=pct>=85?' nearFull':'';
  return `<div class="capacityMeter"><strong class="${remaining===0?'statusBad':remaining<=Math.max(2,Math.ceil(limit*.1))?'statusWarn':'statusGood'}">${esc(state.label||`${remaining} available`)}</strong><div class="subText">${used} / ${limit} used or held</div><div class="capacityMeterLine"><span class="capacityMeterFill${near}" style="width:${pct}%"></span></div><a class="subText" href="${esc(link)}">Manage inventory →</a></div>`;
}
function planRow(plan, ctx) {
  const href = `/admin/plans/${encodeURIComponent(plan.id)}/edit`;
  const accessHref = `/admin/plans/${encodeURIComponent(plan.id)}/access`;
  const lifecycleHref = `/admin/plans/${encodeURIComponent(plan.id)}/lifecycle`;
  const base = readiness.evaluate(plan, ctx);
  const soldOut = Boolean(plan.capacity_state?.soldOut);
  const s = soldOut ? { ...base, key: 'sold_out', kind: 'bad', label: 'Sold out', sellable: false } : base;
  const free = Number(plan.price_minor || 0) === 0;
  const subs = Number(plan.subscription_count || 0);
  const delivery = readiness.deliveryLabel(plan);
  const type = readiness.serviceType(plan);
  const family = planFamily(plan);
  return `<tr class="planListRow" tabindex="0" data-href="${esc(href)}"><td><strong>${esc(plan.name)}</strong> <span class="planTypeTag ${esc(type)}">${esc(serviceLabel(plan))}</span>${plan.is_free_tier ? ' <span class="planTypeTag">Free server plan</span>' : ''}${family === 'legacy' ? ' <span class="planTypeTag legacy">Historical</span>' : ''}<div class="subText">${esc(plan.code)} · v${esc(plan.version_number || 1)} · ${esc(plan.audience)}${type !== 'stremio' ? ` · ${esc(plan.server_class || 'custom')}` : ''}</div></td><td><strong>${esc(delivery)}</strong><div class="subText">${esc(accessModel(plan))}</div></td><td><span class="pill ${s.kind}">${esc(s.label)}</span><div class="subText">${s.sellable ? 'Available for acquisition' : 'New acquisition blocked'}</div></td><td><strong>${esc(priceLabel(plan))}</strong><div class="subText">${free && type === 'jellyfin' && plan.billing_interval !== 'trial' ? 'Usage rules, no billing period' : esc(billingLabel(plan.billing_interval))}</div></td><td>${capacityCell(plan)}</td><td class="right">${esc(subs)}</td><td class="right"><div class="buttonRow"><a class="button secondary btn-sm" href="${esc(href)}">Manage</a><a class="button secondary btn-sm" href="${esc(accessHref)}">Access</a>${free && type === 'jellyfin' && family === 'free' && plan.billing_interval !== 'trial' ? `<a class="button secondary btn-sm" href="${esc(lifecycleHref)}">Usage rules</a>` : ''}<a class="button secondary btn-sm" href="/admin/catalog/plan/${esc(plan.id)}/clone">Clone/version</a></div></td></tr>`;
}
async function withCapacity(rows) {
  if (!rows.length) return rows;
  const counts = await query(`SELECT plan_id,COUNT(DISTINCT customer_id)::int used FROM subscriptions WHERE superseded_by IS NULL AND status IN('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW() GROUP BY plan_id`);
  const map = new Map(counts.rows.map(row => [String(row.plan_id), Number(row.used || 0)]));
  const states=await Promise.all(rows.map(row=>capacity.usage(row.id).catch(()=>({model:'manual_plan',limit:row.capacity_limit??null,used:map.get(String(row.id))||0,reserved:0,remaining:row.capacity_limit==null?null:Math.max(0,Number(row.capacity_limit)-(map.get(String(row.id))||0)),soldOut:row.capacity_limit!=null&&(map.get(String(row.id))||0)>=Number(row.capacity_limit),label:'Availability unavailable',kind:'warn'}))));
  return rows.map((row,index) => ({ ...row, live_subscriber_count: map.get(String(row.id)) || 0,capacity_state:states[index] }));
}
function sectionTable(key, title, description, rows, ctx) {
  if (!rows.length) return '';
  const content = `<div class="tableWrap" data-plan-table-wrap><table class="dataTable responsiveTable" data-plan-table><thead><tr><th>Plan</th><th>Delivery</th><th>Sale readiness</th><th>Price</th><th>Capacity</th><th>Historical subscribers</th><th>Actions</th></tr></thead><tbody>${rows.map(row => planRow(row, ctx)).join('')}</tbody></table></div>`;
  return `<section class="section planFamilySection" data-plan-table-section="${esc(key)}"><div class="sectionHead"><div><h2>${esc(title)}</h2><div class="muted">${esc(description)}</div></div><span class="muted">${rows.length} plan${rows.length === 1 ? '' : 's'}</span></div>${content}</section>`;
}
function createAction(type) {
  if (type === 'stremio') return { href: '/admin/plans/new?type=stremio', label: 'Add Stremio plan' };
  if (type === 'free') return { href: '/admin/plans/new?type=free', label: 'Add Free Server plan' };
  if (type === 'paid' || type === 'jellyfin') return { href: '/admin/plans/new?type=paid', label: 'Add Paid Server plan' };
  return { href: '/admin/plans/new', label: 'Add plan' };
}
function planReadinessHero(rows, ctx, create) {
  if (!rows || !ctx || !create) return '';
  return ui.operatorHero({ title: 'Plans', actionsHtml: '' });
}
async function plansPage(req) {
  await runtimeSettings.ensureLoaded();
  const allRows = await listData().then(withCapacity);
  const ctx = await readiness.context().catch(error => {
    console.warn('Plans readiness context unavailable:', String(error?.message || error).replace(/[\r\n]/g, ' ').slice(0, 200));
    return { stremio: { runtimeReady: false, eligibleServers: 0, readyIndexes: 0 } };
  });
  const type = ['jellyfin', 'stremio', 'free', 'paid', 'reseller', 'legacy'].includes(String(req.query.type || '')) ? String(req.query.type) : '';
  const showArchived = String(req.query.archived || '') === '1';
  const archivedCount = allRows.filter(row => row.archived_at).length;
  const catalogueRows = allRows.filter(row => showArchived ? Boolean(row.archived_at) : !row.archived_at);
  const rows = catalogueRows.filter(row => familyMatches(row, type));
  const create = createAction(type);
  const archiveAction = showArchived
    ? '<a class="button secondary" href="/admin/plans">Active plans</a>'
    : archivedCount ? `<a class="button secondary" href="/admin/plans?archived=1">Archived (${esc(archivedCount)})</a>` : '';
  const action = `<a class="button" href="${esc(create.href)}">${esc(create.label)}</a> <a class="button secondary" href="/admin/plans/access-rules">Access rules</a> <a class="button secondary" href="/admin/plans/order">Storefront order</a> ${archiveAction} <a class="button secondary" href="/admin/plans/export">Export CSV</a>`;
  const groups = { free: [], paid: [], stremio: [], reseller: [], legacy: [] };
  for (const row of rows) (groups[planFamily(row)] || groups.legacy).push(row);
  const sections = [
    sectionTable('free', 'Free Server Plans', 'Free Jellyfin availability is derived from the shared Free server stream-capacity pool.', groups.free, ctx),
    sectionTable('paid', 'Paid Plans', 'Paid Jellyfin plans share Premium server stream capacity; trials also keep their own manual concurrency cap.', groups.paid, ctx),
    sectionTable('stremio', 'Stremio Plans', 'Standalone Stremio availability remains a manually configured place limit.', groups.stremio, ctx),
    sectionTable('reseller', 'Reseller Plans', 'Reseller catalogue plans remain separated from direct customer plans.', groups.reseller, ctx),
    sectionTable('legacy', 'Historical Bundles / Add-ons', 'Historical rows kept for existing customer contracts; new bundle/add-on creation is retired.', groups.legacy, ctx)
  ].join('');
  const empty = `<div class="emptyAction"><div><strong>${showArchived ? 'No archived plans.' : 'No plans in this category yet.'}</strong><div>${showArchived ? 'Retired plans will appear here without affecting existing customer contract history.' : 'Create one from the Plans action button when needed.'}</div></div></div>`;
  const body = `${notice(req)}${productTabs()}${sections || empty}`;
  const active = type === 'jellyfin' ? 'jellyfin-plans' : type === 'stremio' ? 'stremio-plans' : 'plans';
  return layout({
    siteName: runtimeSettings.siteName(),
    active,
    title: showArchived ? 'Archived Plans' : 'Plans',
    subtitle: showArchived ? 'Retired catalogue versions · existing customer contracts remain preserved' : 'Customer plan catalogue',
    body,
    action
  });
}
function createAdminPlansListRouter() {
  const router = express.Router();
  router.use('/admin/plans', gate, noStore);
  router.get('/admin/plans', async (req, res, next) => {
    try { return res.send(await plansPage(req)); }
    catch (error) { return next(error); }
  });
  return router;
}

module.exports = {
  createAdminPlansListRouter,
  plansPage,
  durationLabel,
  priceLabel,
  billingLabel,
  state,
  serviceLabel,
  accessModel,
  planRow,
  withCapacity,
  capacityCell,
  productTabs,
  createAction,
  planReadinessHero
};
