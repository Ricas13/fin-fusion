'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
function read(rel){return fs.readFileSync(path.join(__dirname,'..',rel),'utf8');}

const dashboard=read('src/platform/admin-dashboard.js');
const users=read('src/platform/admin-users.js');
const customer360=read('src/platform/admin-customer-360.js');
const customerView=read('src/platform/admin-customer-360-view.js');
const customerActions=read('src/platform/admin-customer-360-actions.js');
const plans=read('src/platform/admin-plans.js');
const billing=read('src/platform/admin-billing.js');
const payments=read('src/platform/admin-payments.js');
const orders=read('src/platform/admin-orders.js');
const notifications=read('src/platform/admin-notifications.js');
const support=read('src/platform/admin-support.js');
const servers=read('src/platform/admin-servers.js');
const stremio=read('src/platform/admin-stremio.js');
const request=read('src/platform/admin-request-service.js');
const security=read('src/platform/admin-security.js');
const settings=read('src/platform/admin-settings.js');
const mediaServers=read('src/platform/admin-media-servers.js');
const nav=read('src/platform/admin-nav.js');
const html=read('src/platform/admin-html.js');
const ui=read('src/platform/admin-ui.js');
const css=read('public/css/admin-v2.css');
const app=read('src/platform/application.js');
const customerPortal=read('views/customer/portal.ejs');
const customerPartials=read('views/customer/partials/subscription-card.ejs');
const customerJs=read('public/js/customer-portal.js');

for(const contract of ['operatorHero','operatorSummary','operatorCallout','detailDisclosure','sectionHeader'])assert(ui.includes(`function ${contract}`),`shared admin UI helper ${contract} is required`);
assert(css.includes('.operatorHero')&&css.includes('.operatorSummary')&&css.includes('.operatorCallout'), 'shared operator visual hierarchy CSS is required');
assert(css.includes('.detailDisclosure'), 'progressive disclosure must have shared visual treatment');

const shellContracts=['headerAttentionLink','headerSearch','New','Alerts','Inbox'];
for(const contract of shellContracts)assert(html.includes(contract),`global admin shell must expose ${contract}`);
assert(!html.includes('Operational alerts')&&!html.includes('adminHeaderOperational'), 'the duplicate four-counter operational alert row must stay retired');

assert(dashboard.includes("ui.operatorHero({tone:'commerce'"), 'main dashboard must lead with one operator hero');
assert(dashboard.includes('New since last read')&&dashboard.includes('Alerts')&&dashboard.includes('Inbox'), 'main dashboard hero must explain the three global operator signal buckets');
assert(dashboard.includes('Needs Attention'), 'main dashboard must keep Needs Attention visible');

assert(users.includes("ui.operatorHero({tone:'people'"), 'customer list must lead with an operator hero');
assert(users.includes('Needs attention')&&users.includes('Recently joined'), 'customer list must separate customer exceptions from recent customer context');
assert(users.includes("ui.detailDisclosure({title:`Recently joined"), 'recent customers must be progressively disclosed');

assert(customer360.includes('Current plan')&&customer360.includes('Server access')&&customer360.includes('30-day usage'), 'Customer 360 must lead with current customer state');
assert(customer360.includes("['overview','Overview']")&&customer360.includes("['access','Access']")&&customer360.includes("['billing','Billing']")&&customer360.includes("['activity','Activity']"), 'Customer 360 primary nav must be task based');
assert(customerView.includes('Access & service')&&customerView.includes('Billing summary'), 'Customer 360 tabs must expose task-oriented state');
assert(customerActions.includes('Administrative actions')&&customerActions.includes('Danger zone'), 'Customer 360 must keep destructive/admin actions secondary');

assert(plans.includes("ui.operatorHero({tone:'plans'"), 'Plans must lead with an operator hero');
assert(plans.includes('Plan catalogue'), 'Plans must describe the catalogue instead of exposing raw configuration first');

assert(payments.includes('Payment gateways'), 'Payments must frame provider setup as gateway configuration');
assert(orders.includes('Transaction desk')&&orders.includes('Open customer billing →'), 'Orders must act as a transaction trail into customer billing rather than a raw record table');
assert(orders.includes("ui.detailDisclosure({title:`Full purchase history"), 'Older order history must be progressively disclosed');
assert(!orders.includes('provider_subscription_id'), 'Orders must not expose provider subscription identifiers in the normal transaction view');

assert(billing.includes('Billing operations') && billing.includes('Fix these subscriptions first'), 'Billing must expose customer-impacting recurring problems before routine reconciliation');
assert(billing.includes("row.status==='past_due'||Boolean(row.last_error)"), 'Billing problems must derive from canonical subscription/provider-sync state');
assert(billing.includes('Missing provider links')&&billing.includes('Resolve missing links'), 'Billing must permanently expose unlinked paid subscriptions as operator work');
assert(billing.includes("ui.detailDisclosure({title:`Healthy / linked recurring subscriptions"), 'Healthy recurring-subscription state must remain progressively disclosed behind the missing-link queue');
assert(!billing.includes('<th>Provider ID</th>'), 'Billing default tables must not make raw provider identifiers an operator-facing column');

assert(support.includes('Support desk') && support.includes('Reply these first'), 'Support must lead with customer conversations waiting on staff');
assert(support.includes("['open','awaiting_staff'].includes(row.status)"), 'Support priority must reuse canonical ticket lifecycle state');
assert(support.includes("ui.detailDisclosure({title:'Ticket routing & status'"), 'Support routing/status controls must stay secondary to the conversation and reply action');
assert(support.includes('Internal note (staff only)'), 'Support clarity must preserve the internal-note privacy boundary');

assert(notifications.includes('Notification operations'), 'Notifications must lead with delivery operations');
assert(notifications.includes('Failures waiting for retry')||notifications.includes('failed'), 'Notifications must surface delivery failures before setup details');

assert(servers.includes('Jellyfin Server estate'), 'Servers must be framed as an estate, not a raw record list');
assert(stremio.includes('Stremio operations'), 'Stremio must lead with operational readiness');
assert(request.includes('Request Service operations'), 'Request Service must lead with operational readiness');
assert(security.includes('Security operations'), 'Security must lead with security operations');
assert(settings.includes('Platform settings'), 'Settings must lead with platform configuration');
assert(mediaServers.includes('Media Server provider'), 'Media Server settings must lead with provider status');

assert(nav.includes('Payments & Billing'), 'navigation must preserve the task-oriented Payments & Billing destination');
assert(!nav.includes('Reconciliation') || billing.includes('Provider reconciliation'), 'reconciliation must stay inside Billing rather than becoming a new top-level destination');

const stableCustomerNav=`${customer360}\n${customerView}\n${customerActions}`;
assert(!stableCustomerNav.includes("['manage','Manage'") && !stableCustomerNav.includes("['security','Security'") && !stableCustomerNav.includes("['history','History'"), 'Customer 360 primary navigation must be exactly Overview, Access, Billing and Activity');
assert(stableCustomerNav.includes("link.setAttribute('href',href)") && stableCustomerNav.includes('MutationObserver'), 'late service-aware enrichment must not mutate Customer 360 navigation after render');

assert(customerPortal.includes('Your services')||customerPortal.includes('subscription'), 'customer portal must stay centered on customer services');
assert(customerPartials.includes('plan')||customerPartials.includes('subscription'), 'customer subscription partial must keep service state visible');
assert(customerJs.includes('fetch')||customerJs.includes('addEventListener'), 'customer portal behavior must remain external-script owned');
assert(app.includes('createApplication')||app.includes('createApp'), 'application composition entrypoint must remain present');

console.log('Admin operator clarity smoke passed.');
