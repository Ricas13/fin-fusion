'use strict';

const moneyFormat=require('./money-format');
const express = require('express');
const { query } = require('../db');
const { esc, layout } = require('./admin-html');
const { listData } = require('./admin-plans');
const runtimeSettings = require('./runtime-settings');
const readiness = require('./product-readiness');
const planComponents = require('../access/plan-components');
const capacity = require('../entitlements/plan-capacity');
const serviceCatalog = require('../catalog/service-catalog');
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
  return minor === 0 ? 'Free' : moneyFormat.formatMinor(minor,plan?.currency||'GBP');
}
function billingLabel(value) {
  return ({ trial: 'Trial', month: 'Monthly', '6_months': '6 months', year: 'Yearly', custom: 'Custom' })[value] || 'Custom';
}
function state(plan) { return readiness.catalogueState(plan); }
function serviceLabel(plan) {
  return serviceCatalog.planLabel(plan);
}
function accessModel(plan) { return planComponents.accessLabel(plan) || 'Access not configured'; }
function productTabs() { return ''; }
function planFamily(plan) {
  const service = readiness.serviceType(plan), audience = String(plan.audience || 'direct');
  if (plan.is_addon || service === 'bundle') return 'legacy';
  if (audience === 'reseller') return 'reseller';
  if (service === 'stremio') return 'stremio';
  if (service === 'emby') return 'emby';
  if (service === 'jellyfin' && (plan.is_free_tier || (Number(plan.price_minor || 0) === 0 && String(plan.billing_interval || '') !== 'trial'))) return 'free';
  return 'paid';
}
function familyMatches(plan, type) {
  if (!type) return true;
  const family = planFamily(plan), service = readiness.serviceType(plan);
  if (type === 'jellyfin') return family === 'free' || family === 'paid';
  if (type === 'stremio') return family === 'stremio';
  if (type === 'emby') return family === 'emby';
  return family === type || service === type;
}
function plural(value, singular, pluralValue=`${singular}s`) {
  return Number(value) === 1 ? singular : pluralValue;
}
function hiddenPlan(plan) {
  return readiness.catalogueState(plan).key === 'hidden';
}
function hiddenPlanDisclosureStyles() {
  return `<style>
.planHiddenDisclosureRow>td{padding:0!important;border-top:1px solid #2a3540!important;background:#0f161e!important}
.planHiddenDisclosure{position:relative;display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;padding:11px 14px;box-sizing:border-box;cursor:pointer;color:#9dacba;background:linear-gradient(90deg,rgba(247,185,85,.055),rgba(255,255,255,.012));transition:background .16s ease,color .16s ease}
.planHiddenDisclosure:hover{background:linear-gradient(90deg,rgba(247,185,85,.09),rgba(255,255,255,.02));color:#d8e0e7}
.planHiddenToggle{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.planHiddenDisclosure:has(.planHiddenToggle:focus-visible){outline:2px solid #4cc9f0;outline-offset:-2px}
.planHiddenDisclosureTitle{display:flex;align-items:center;gap:8px;font-weight:800;color:#d5dde5}
.planHiddenDisclosureDot{width:7px;height:7px;border-radius:50%;background:#f7b955;box-shadow:0 0 0 4px rgba(247,185,85,.09)}
.planHiddenDisclosureCount{display:inline-grid;place-items:center;min-width:23px;height:19px;padding:0 6px;border:1px solid rgba(247,185,85,.22);border-radius:999px;background:rgba(247,185,85,.08);color:#f3c978;font-size:10px;font-weight:850}
.planHiddenDisclosureHint{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.045em;color:#8393a3}
.planHiddenDisclosureChevron{width:14px;height:14px;transition:transform .18s ease}
.planHiddenWhenOpen{display:none}
.planHiddenPlanRow{display:none}
tbody:has(.planHiddenToggle:checked) .planHiddenPlanRow{display:table-row}
tbody:has(.planHiddenToggle:checked) .planHiddenWhenClosed{display:none}
tbody:has(.planHiddenToggle:checked) .planHiddenWhenOpen{display:inline}
tbody:has(.planHiddenToggle:checked) .planHiddenDisclosureChevron{transform:rotate(180deg)}
tbody:has(.planHiddenToggle:checked) .planHiddenDisclosure{background:linear-gradient(90deg,rgba(247,185,85,.075),rgba(255,255,255,.018));border-bottom:1px solid rgba(247,185,85,.12)}
@media(max-width:760px){.planHiddenDisclosure{padding:10px 11px}.planHiddenDisclosureHint{font-size:9px}.planHiddenDisclosureTitle{font-size:12px}}
</style>`;
}

function capacityCell(plan) {
  const link = `/admin/plans/${encodeURIComponent(plan.id)}/inventory`,state=plan.capacity_state||{},customers=Math.max(0,Number(plan.live_subscriber_count||0));
  if(state.model==='fleet_users'){
    const remaining=Math.max(0,Number(state.remaining||0)),limit=state.userLimit==null?null:Math.max(0,Number(state.userLimit)),used=limit==null?0:Math.max(0,limit-remaining),pct=limit?Math.min(100,Math.max(0,Math.round((used/limit)*100))):100,near=pct>=85?' nearFull':'';
    const managed=Math.max(0,Number(state.managedUsers||0)),pending=Math.max(0,Number(state.pendingUsers||0)),held=Math.max(0,Number(state.reservedUsers||0));
    return `<div class="capacityMeter"><strong class="${state.soldOut?'statusBad':remaining<=10?'statusWarn':'statusGood'}">${esc(state.label||`${remaining} available`)}</strong><div class="subText">${managed}/${limit??'—'} managed users${pending?` · ${pending} awaiting access`:''}${held?` · ${held} held`:''}</div><div class="capacityMeterLine"><span class="capacityMeterFill${near}" style="width:${pct}%"></span></div><a class="subText" href="${esc(link)}">View server user capacity →</a></div>`;
  }
  const limit=state.limit==null?null:Number(state.limit),used=Number(state.used||0)+Number(state.reserved||0);
  if(limit==null)return `<span class="statusPill statusWarn">Inventory not configured</span><div class="subText">${customers} ${plural(customers,'customer')} currently active · no customer limit configured</div><a class="subText" href="${esc(link)}">Set customer availability →</a>`;
  if(limit===0)return `<div class="capacityMeter"><strong class="statusBad">Closed · 0 available</strong><div class="subText">${customers?`${customers} existing ${plural(customers,'customer')} unaffected`:'No new acquisition'}</div><div class="capacityMeterLine"><span class="capacityMeterFill nearFull" style="width:100%"></span></div><a class="subText" href="${esc(link)}">Open customer availability →</a></div>`;
  const remaining=Math.max(0,Number(state.remaining||0)),pct=Math.min(100,Math.round((used/limit)*100)),near=pct>=85?' nearFull':'';
  return `<div class="capacityMeter"><strong class="${remaining===0?'statusBad':remaining<=Math.max(2,Math.ceil(limit*.1))?'statusWarn':'statusGood'}">${esc(state.label||`${remaining} available`)}</strong><div class="subText">${customers} ${plural(customers,'customer')} on this plan · ${remaining} new ${plural(remaining,'place')} available</div><div class="capacityMeterLine"><span class="capacityMeterFill${near}" style="width:${pct}%"></span></div><a class="subText" href="${esc(link)}">Manage customer availability →</a></div>`;
}
function planRow(plan, ctx, extraClass = '') {
  const href = `/admin/plans/${encodeURIComponent(plan.id)}/edit`;
  const accessHref = `/admin/plans/${encodeURIComponent(plan.id)}/access`;
  const lifecycleHref = `/admin/plans/${encodeURIComponent(plan.id)}/lifecycle`;
  const base = readiness.evaluate(plan, ctx);
  const soldOut = Boolean(plan.capacity_state?.soldOut);
  const s = soldOut ? { ...base, key: 'sold_out', kind: 'bad', label: 'Sold out', sellable: false } : base;
  const free = Number(plan.price_minor || 0) === 0;
  const delivery = readiness.deliveryLabel(plan);
  const type = readiness.serviceType(plan);
  const family = planFamily(plan);
  const rowClass = `planListRow${extraClass ? ` ${extraClass}` : ''}`;
  return `<tr class="${esc(rowClass)}" tabindex="0" data-href="${esc(href)}"><td><strong>${esc(plan.name)}</strong> <span class="planTypeTag ${esc(type)}">${esc(serviceLabel(plan))}</span>${plan.is_free_tier ? ' <span class="planTypeTag">Free server plan</span>' : ''}${family === 'legacy' ? ' <span class="planTypeTag legacy">Historical</span>' : ''}<div class="subText">${esc(plan.code)} · v${esc(plan.version_number || 1)} · ${esc(plan.audience)}${type !== 'stremio' ? ` · ${esc(plan.server_class || 'custom')}` : ''}</div></td><td><strong>${esc(delivery)}</strong><div class="subText">${esc(accessModel(plan))}</div></td><td><span class="pill ${s.kind}">${esc(s.label)}</span><div class="subText">${s.sellable ? 'Available for acquisition' : 'New acquisition blocked'}</div></td><td><strong>${esc(priceLabel(plan))}</strong><div class="subText">${free && type === 'jellyfin' && plan.billing_interval !== 'trial' ? 'Usage rules, no billing period' : esc(billingLabel(plan.billing_interval))}</div></td><td>${capacityCell(plan)}</td><td class="right planActionsCell"><div class="buttonRow planActionsRow"><a class="button secondary btn-sm" href="${esc(href)}">Manage</a><a class="button secondary btn-sm" href="${esc(accessHref)}">Access</a>${free && type === 'jellyfin' && family === 'free' && plan.billing_interval !== 'trial' ? `<a class="button secondary btn-sm" href="${esc(lifecycleHref)}">Usage rules</a>` : ''}<a class="button secondary btn-sm" href="/admin/catalog/plan/${esc(plan.id)}/clone">Clone/version</a></div></td></tr>`;
}
async function withCapacity(rows) {
  if (!rows.length) return rows;
  const counts = await query(`SELECT plan_id,COUNT(DISTINCT customer_id)::int used FROM subscriptions WHERE superseded_by IS NULL AND status IN('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW() GROUP BY plan_id`);
  const map = new Map(counts.rows.map(row => [String(row.plan_id), Number(row.used || 0)]));
  const states=await Promise.all(rows.map(row=>capacity.usage(row.id).catch(()=>{
    const jellyfin=['jellyfin','bundle'].includes(String(row.service_type||''));
    if(jellyfin)return{model:'fleet_users',userLimit:0,managedUsers:0,pendingUsers:0,reservedUsers:0,limit:0,used:0,reserved:0,remaining:0,soldOut:true,label:'Server capacity unavailable',kind:'warn'};
    const used=map.get(String(row.id))||0,limit=row.capacity_limit??null;
    return{model:'manual_plan',limit,used,reserved:0,remaining:limit==null?null:Math.max(0,Number(limit)-used),soldOut:limit!=null&&used>=Number(limit),label:'Availability unavailable',kind:'warn'};
  })));
  return rows.map((row,index) => ({ ...row, live_subscriber_count: map.get(String(row.id)) || 0,capacity_state:states[index] }));
}
function sectionTable(key, title, description, rows, ctx, { keepEmpty = false, emptyHtml = '' } = {}) {
  if (!rows.length && !keepEmpty) return '';
  const visibleRows = rows.filter(row => !hiddenPlan(row));
  const hiddenRows = rows.filter(hiddenPlan);
  const hiddenDisclosure = hiddenRows.length
    ? `<tr class="planHiddenDisclosureRow"><td colspan="6"><label class="planHiddenDisclosure"><input class="planHiddenToggle" type="checkbox"><span class="planHiddenDisclosureTitle"><span class="planHiddenDisclosureDot" aria-hidden="true"></span>Hidden plans <span class="planHiddenDisclosureCount">${hiddenRows.length}</span></span><span class="planHiddenDisclosureHint"><span class="planHiddenWhenClosed">Show hidden plans</span><span class="planHiddenWhenOpen">Hide hidden plans</span><svg class="planHiddenDisclosureChevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span></label></td></tr>${hiddenRows.map(row => planRow(row, ctx, 'planHiddenPlanRow')).join('')}`
    : '';
  const content = rows.length
    ? `<div class="tableWrap" data-plan-table-wrap><table class="dataTable responsiveTable" data-plan-table><thead><tr><th>Plan</th><th>Delivery</th><th>Sale readiness</th><th>Price</th><th>Customer availability</th><th class="right planActionsCell">Actions</th></tr></thead><tbody>${visibleRows.map(row => planRow(row, ctx)).join('')}${hiddenDisclosure}</tbody></table></div>`
    : emptyHtml;
  return `<section class="section planFamilySection" data-plan-table-section="${esc(key)}"><div class="sectionHead"><div><h2>${esc(title)}</h2><div class="muted">${esc(description)}</div></div><span class="muted">${rows.length} plan${rows.length === 1 ? '' : 's'}</span></div>${content}</section>`;
}
function createAction(type) {
  if (type === 'stremio') return { href: '/admin/plans/new?type=stremio', label: 'Add Stremio Share plan' };
  if (type === 'emby') return { href: '/admin/plans/new?type=emby', label: 'Add Emby Share plan' };
  if (type === 'free') return { href: '/admin/plans/new?type=free', label: 'Add Free Server plan' };
  if (type === 'paid' || type === 'jellyfin') return { href: '/admin/plans/new?type=paid', label: 'Add Jellyfin Share plan' };
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
    return { stremio: { runtimeReady: false, eligibleServers: 0, readyIndexes: 0 }, emby: { eligibleServers: 0 } };
  });
  const type = ['jellyfin', 'stremio', 'emby', 'free', 'paid', 'reseller', 'legacy'].includes(String(req.query.type || '')) ? String(req.query.type) : '';
  const showArchived = String(req.query.archived || '') === '1';
  const archivedCount = allRows.filter(row => row.archived_at).length;
  const catalogueRows = allRows.filter(row => showArchived ? Boolean(row.archived_at) : !row.archived_at);
  const rows = catalogueRows.filter(row => familyMatches(row, type));
  const create = createAction(type);
  const archiveAction = showArchived
    ? '<a class="button secondary" href="/admin/plans">Active plans</a>'
    : archivedCount ? `<a class="button secondary" href="/admin/plans?archived=1">Archived (${esc(archivedCount)})</a>` : '';
  const action = `<a class="button" href="${esc(create.href)}">${esc(create.label)}</a> <a class="button secondary" href="/admin/plans/access-rules">Access rules</a> <a class="button secondary" href="/admin/plans/order">Storefront order</a> ${archiveAction} <a class="button secondary" href="/admin/plans/export">Export CSV</a>`;
  const groups = { free: [], paid: [], stremio: [], emby: [], reseller: [], legacy: [] };
  for (const row of rows) (groups[planFamily(row)] || groups.legacy).push(row);
  const showEmbyZeroState = !showArchived && (!type || type === 'emby');
  const embyEmpty = `<div class="emptyAction"><div><strong>No Emby Share plans yet.</strong><div>Create the first Emby Share when you want this product to appear on the public storefront.</div></div><a class="button" href="/admin/plans/new?type=emby">Add Emby Share plan</a></div>`;
  const sections = [
    sectionTable('free', 'Free Server Plans', 'Free Jellyfin availability comes directly from Free server user capacity. One customer uses one place.', groups.free, ctx),
    sectionTable('paid', 'Jellyfin Shares', 'Paid Jellyfin availability comes directly from eligible server user capacity. One customer uses one place.', groups.paid, ctx),
    sectionTable('emby', 'Emby Shares', 'Standalone Emby Share plans use Emby-only server placement and an independent customer entitlement.', groups.emby, ctx, { keepEmpty: showEmbyZeroState, emptyHtml: embyEmpty }),
    sectionTable('stremio', 'Stremio Shares', 'Standalone Stremio shares use a manually configured customer place limit.', groups.stremio, ctx),
    sectionTable('reseller', 'Reseller Plans', 'Reseller catalogue plans remain separated from direct customer plans.', groups.reseller, ctx),
    sectionTable('legacy', 'Historical Bundles / Add-ons', 'Historical rows kept for existing customer contracts; new bundle/add-on creation is retired.', groups.legacy, ctx)
  ].join('');
  const empty = `<div class="emptyAction"><div><strong>${showArchived ? 'No archived plans.' : 'No plans in this category yet.'}</strong><div>${showArchived ? 'Retired plans will appear here without affecting existing customer contract history.' : 'Create one from the Plans action button when needed.'}</div></div></div>`;
  const body = `${hiddenPlanDisclosureStyles()}${notice(req)}${productTabs()}${sections || empty}`;
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
  planFamily,
  familyMatches,
  planRow,
  withCapacity,
  capacityCell,
  productTabs,
  createAction,
  planReadinessHero
};