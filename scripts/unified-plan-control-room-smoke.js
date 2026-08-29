'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const routes = read('src/platform/admin-route-composition.js');
const editor = read('src/platform/admin-jellyfin-plan-editor.js');
const stremioEditor = read('src/platform/admin-stremio-plan-editor.js');
const stremioDispatch = read('src/platform/admin-stremio-plan-dispatch.js');
const attentionPolicy = read('src/platform/actionable-attention-policy.js');
const operatorState = read('src/platform/admin-operator-state.js');
const attentionSource = read('src/platform/attention.js');
const css = read('public/css/admin-plan-control-room.css');
const densityCss = read('public/css/admin-card-density.css');
const capability = read('public/css/admin-capability.css');
const attention = read('src/platform/admin-attention.js');
const baseline = read('db/migrations/000_database_baseline.sql');

assert(routes.includes('createAdminJellyfinPlanEditorRouter'), 'route composition must mount the unified Jellyfin plan editor');
assert(routes.indexOf('createAdminJellyfinPlanEditorRouter()') < routes.indexOf('createAdminPlanAccessRouter()'), 'unified Jellyfin dispatch must run before legacy plan GET owners');
assert(editor.includes('const pathname = req.path') && editor.includes("pathname.match(/^\\/admin\\/plans\\/([^/]+)\\/edit$/)"), 'unified editor must dispatch the canonical Jellyfin edit page without registering a duplicate formal GET owner');
assert(!editor.includes("router.get('/admin/plans/:id/edit'"), 'unified editor must not duplicate the assembled /edit route owner');
for (const anchor of ['access', 'availability', 'delivery', 'libraries', 'commerce']) {
  assert(editor.includes(`'${anchor}'`), `unified editor must expose/redirect the ${anchor} configuration area`);
}
assert(editor.includes("String(plan?.service_type || 'jellyfin') === 'jellyfin'"), 'unified editor must target current Jellyfin products only, not retired historical bundle products');
assert(editor.includes("if (data.free) return '';"), 'free plans must omit the commercial/payment card entirely');
assert(editor.includes('No billing cycle or payment provider applies'), 'free plan UI must explain its independence from paid commerce');
assert(editor.includes('Free plan independence:'), 'free plan editor must explicitly keep commerce outside free-plan configuration');
assert(editor.includes('editor-product') && editor.includes('editor-access') && editor.includes('editor-availability') && editor.includes('editor-delivery') && editor.includes('editor-libraries'), 'single-page plan cards must have independent save handlers');
assert(editor.includes('editor-commerce') && editor.includes('editor-payments'), 'paid Jellyfin plans must configure schedule and payment options from the unified page');
assert(editor.includes('data-jellyfin-access-model'), 'Jellyfin access card must preserve streams-vs-household policy switching');
assert(editor.includes('Maximum plan slots'), 'availability must be configurable directly in the unified editor');
assert(editor.includes('Delivery & server placement'), 'server class and placement must be configured in the unified editor');
assert(editor.includes('Library access'), 'library access must be configured in the unified editor');
assert(baseline.includes("marketing_features text[] DEFAULT '{}'::text[] NOT NULL"), 'baseline must keep marketing features as a PostgreSQL text array');
assert(editor.includes('marketing_features=$4::text[]'), 'product editor must persist homepage features using the schema text-array type');
assert(!editor.includes('marketing_features=$4::jsonb'), 'product editor must never cast marketing features to jsonb');
assert(editor.includes('[plan.id, name, description, features, visible, active]'), 'product editor must bind the feature array directly instead of JSON-encoding it');

assert(stremioEditor.includes('Plan, storefront & commerce') && stremioEditor.includes('name="description"') && stremioEditor.includes('name="feature${i+1}"'), 'Stremio must edit storefront copy inside its existing product/commerce card');
assert(stremioEditor.includes('UPDATE plans SET name=$2,description=$3,marketing_features=$4::text[],billing_interval=$5,duration_days=$6'), 'the Stremio product/commerce save must persist storefront copy in the same mutation');
assert(stremioEditor.includes("post('editor-storefront',saveStorefront,'Storefront saved.')"), 'legacy Storefront POST must remain accepted by the compatibility Stremio editor router');
assert(stremioEditor.includes('UPDATE plans SET description=$2,marketing_features=$3::text[],updated_at=NOW() WHERE id=$1'), 'Storefront compatibility save must write the same description/features columns without changing commerce ownership');
assert(!stremioEditor.includes('Save storefront'), 'Stremio must not render a second Storefront Save button or editor');
assert(stremioEditor.includes("if(!data.sources.length)return") && stremioEditor.includes('Manage sources'), 'empty Stremio Sources must point to source management instead of presenting a useless Save');
assert(stremioEditor.includes("res.redirect(`/admin/plans?error=${encodeURIComponent(error.message||'Plan not found')}`)"), 'missing Stremio plans must return to the catalogue with an error notice instead of rendering Not found as page/header content');
assert(routes.includes('createAdminStremioPlanDispatchRouter'), 'route composition must mount the live Stremio plan dispatcher');
assert(routes.indexOf('createAdminStremioPlanDispatchRouter()') < routes.indexOf('createAdminJellyfinPlanEditorRouter()'), 'Stremio card saves must be dispatched before shared Jellyfin plan routes can match them');
assert(stremioDispatch.includes('(editor-commerce|editor-storefront|editor-access|editor-availability|editor-payments)'), 'the mounted Stremio dispatcher must own every card POST rendered by the Stremio edit page');
for (const [action, handler] of [['editor-commerce','saveCommerce'],['editor-storefront','saveStorefront'],['editor-access','saveAccess'],['editor-availability','saveAvailability'],['editor-payments','savePayments']]) {
  assert(stremioDispatch.includes(`['${action}',{handler:editor.${handler}`), `mounted Stremio dispatcher must route ${action} to editor.${handler}`);
}
assert(stremioDispatch.includes("if(!data||String(data.plan.service_type)!=='stremio')return next();"), 'Stremio card dispatch must fall through for non-Stremio plans so Jellyfin routing remains intact');
assert(stremioDispatch.includes("cardRedirect(res,data.plan.id,'error'"), 'Stremio card save failures must return to the same editor with a useful error instead of falling through to Not found');

assert(attentionPolicy.includes("const REQUIRED_ENABLED_JOBS = new Set(['payment_events', 'plan_changes'])"), 'payment-event retry and plan-change lifecycle jobs must be declared operator-required');
assert(attentionPolicy.includes("health === 'disabled' && REQUIRED_ENABLED_JOBS.has(jobKey)") && attentionPolicy.includes("reason: 'disabled'"), 'disabled required payment lifecycle jobs must become operator-visible alerts immediately');
assert(attentionSource.includes('jobHealth.list()'), 'Needs Attention must derive job alerts from the canonical automation job snapshot');
assert(operatorState.includes('attention.openSummary()'), 'header Alerts count must use the same Needs Attention snapshot as the Alerts page');

assert(capability.includes("@import url('/css/admin-plan-control-room.css')"), 'shared admin shell must load the plan/attention layout corrections');
assert(css.includes('.planControlGrid{display:grid;grid-template-columns:1fr!important'), 'plan editor must default to one configuration job per row');
assert(css.includes('@media(min-width:1100px)') && css.includes('.planControlGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important'), 'plan editor must use at most two columns on wide screens');
assert(css.includes('.planControlGrid>#access,.planControlGrid>#availability{grid-column:auto!important}'), 'Access and Availability must be the deliberate two-card pair');
assert(css.includes('.planConfigCard.span2,.planConfigCard.span3{grid-column:1/-1!important}'), 'legacy span classes must resolve to full-width cards rather than mosaics');
assert(css.includes('.planControlGrid>.requestPlanCard{grid-column:1/-1!important'), 'request/Jellyseerr policy must remain a full-width monster card');
assert(css.includes('overflow-wrap:normal;word-break:normal;hyphens:none'), 'toggle titles must not wrap in the middle of words');
assert(!densityCss.includes('.planControlGrid{') && !densityCss.includes('.planControlGrid>'), 'card-density CSS must not override planControlGrid geometry or spans');
assert(css.includes('.planControlHeader{display:none!important}'), 'duplicate plan status strip must stay out of the editor');
assert(css.includes('@media(max-width:700px)') && css.includes('.planControlGrid{grid-template-columns:1fr!important}'), 'plan editor must stay one column on small screens');
assert(css.includes('.planControlRoom,.planControlGrid{gap:12px}') && css.includes('.planConfigBody{padding:12px 13px}'), 'narrow plan editors must retain readable card spacing instead of desktop-density padding');
assert(css.includes('@media(max-width:480px)') && css.includes('.planServerChoice{grid-template-columns:auto minmax(0,1fr)}'), 'very narrow server controls must stack the weight input rather than squeeze three columns');
assert(css.includes('.section.bulkBar{overflow:visible}'), 'bulk-action sections must not clip controls or focus rings at the shared section boundary');
assert(css.includes('.attentionBulkBar .input.compact,.attentionActionGrid .input.compact{min-width:0!important'), 'attention workflow inputs must be allowed to shrink instead of forcing horizontal overflow');
assert(css.includes('.attentionActionGrid{grid-template-columns:minmax(92px'), 'attention row workflow must use bounded responsive columns');
assert(attention.includes('responsiveTable attentionTable'), 'Needs Attention table must opt into the constrained workflow layout');

console.log('unified plan control room smoke: ok');
