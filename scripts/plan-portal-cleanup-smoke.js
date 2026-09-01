'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const plansList = read('src/platform/admin-plans-list.js');
const createPlan = read('src/platform/admin-plan-create-v2.js');
const delivery = read('src/platform/admin-plan-delivery.js');
const lifecycle = read('src/platform/admin-jellyfin-plan-editor.js');
const jobs = read('src/automation/jobs.js');
const storefront = read('src/platform/storefront.js');
const serviceCatalog = read('src/catalog/service-catalog.js');
const operatorExperience = read('public/js/operator-experience.js');
const operatorBusiness = read('public/js/operator-business-indicators.js');
const adminShell = read('src/platform/admin-html-core-base.js');
const nav = read('src/platform/admin-nav.js');
const productModules = read('src/platform/admin-product-modules.js');
const stremioRuntime = read('src/stremio/runtime.js');
const migration = read('db/migrations/025_plan_portal_cleanup.sql');

for (const label of ['Free Server Plans', 'Jellyfin Shares', 'Emby Shares', 'Stremio Shares', 'Reseller Plans']) {
  assert(plansList.includes(label), `Plans page must render ${label}`);
}
const freeIndex=plansList.indexOf("sectionTable('free', 'Free Server Plans'");
const jellyfinIndex=plansList.indexOf("sectionTable('paid', 'Jellyfin Shares'");
const embyIndex=plansList.indexOf("sectionTable('emby', 'Emby Shares'");
const stremioIndex=plansList.indexOf("sectionTable('stremio', 'Stremio Shares'");
assert(freeIndex>=0&&jellyfinIndex>freeIndex&&embyIndex>jellyfinIndex&&stremioIndex>embyIndex,'Plans page must order Free Server, Jellyfin Shares, Emby Shares, then Stremio Shares');
assert(!plansList.includes('Historical subscribers'),'Plans table must not restore the historical-subscriber column');
assert(plansList.includes('Customer availability')&&plansList.includes('customers} ${plural(customers,\'customer\')} on this plan'),'Plans capacity must be presented in customer terms');
assert(plansList.includes('planActionsCell')&&plansList.includes('planActionsRow'),'Plans table must reserve the reclaimed column width for one-line actions');
assert(plansList.includes('Historical Bundles / Add-ons'), 'historical bundle/add-on rows must be isolated from current plan families');
assert(!operatorExperience.includes("['Bundles','/admin/plans?type=bundle']"), 'client-side bundle plan tabs must not be reintroduced');
assert(createPlan.includes("const SERVICE_TYPES = ['jellyfin', 'stremio']"), 'shared new-plan creation must remain limited to Jellyfin and Stremio while Emby uses its dedicated editor');
assert(createPlan.includes('Add-ons are retired') && createPlan.includes('Choose Jellyfin or Stremio'), 'retired add-on/bundle submissions must fail clearly');
assert(delivery.includes('Bundle delivery is retired for new setup') && !delivery.includes("option('bundle'"), 'delivery editor must not offer bundle delivery');
assert(lifecycle.includes('minimumPlaybackMinutes') && lifecycle.includes('playbackWindowDays') && lifecycle.includes('Minimum observation'), 'free-plan lifecycle editor must expose all usage-rule fields');
assert(jobs.includes('customerInactivity.run()'), 'scheduled inactivity job must use the plan-aware worker');
assert(storefront.includes('serviceCatalog.storefrontSections(plans)') && serviceCatalog.includes("!plan.is_addon && serviceType(plan) !== 'bundle'") && serviceCatalog.includes("return ['jellyfin', 'stremio', 'emby']") && serviceCatalog.includes("description: 'Standalone Stremio access.'"), 'storefront must hide add-ons and historical bundles while retaining catalogue-driven standalone Stremio and Emby sections');
assert(operatorBusiness.includes('markAreaRead(area,data)') && operatorBusiness.includes('markAreaReadWithRetry') && operatorBusiness.includes('return await fetchSnapshot()') && operatorBusiness.includes('.then(fresh=>apply(fresh||data))'), 'business unread badges must persist the current-area acknowledgement, retry transient failures and repaint from a fresh server snapshot');
assert(operatorBusiness.includes("setSignal('new',areaForCurrentPage==='customers'?0:customers)") && operatorBusiness.includes("areaForCurrentPage==='tickets'?0:tickets") && operatorBusiness.includes("areaForCurrentPage==='orders'?0:orders"), 'the open business workspace must not keep presenting its own split unread signal');
assert(!operatorBusiness.includes('data.counts[areaForCurrentPage]=0'), 'business unread badges must remain server-authoritative rather than mutating the returned snapshot');
assert(!adminShell.includes('<summary class="navSectionLabel"><a class="navSectionHome"'), 'sidebar summary must not contain a nested link');
assert(nav.includes("['stremio-playback','IP access','/admin/stremio/playback']"), 'Stremio household controls must remain available through the plain-language IP access workspace');
assert(productModules.includes('Current household IP leases') && productModules.includes('/stremio-household/reset') && productModules.includes('Reset lease'), 'Stremio household lease view must expose admin reset controls');
assert(!productModules.includes('se.plan_id') && productModules.includes('LEFT JOIN subscriptions sub ON sub.id=se.subscription_id'), 'Stremio household lease plan labels must resolve through subscriptions');
assert(stremioRuntime.includes('STREAM_RESULT_CACHE_TTL_MS') && stremioRuntime.includes('cachedStreams(entitlement.id, type, videoId, origin)'), 'Stremio stream discovery must cache allowed search results briefly');
assert(migration.includes("service_type='bundle'") && migration.includes("widget_key IN ('mrr','grossRevenue','netRevenue','payingCustomersArpu')"), 'cleanup migration must hide retired catalogue rows and repair Commerce KPI layout');

console.log('plan portal cleanup smoke: ok');