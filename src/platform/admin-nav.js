'use strict';

// Keep the permanent sidebar focused on the few places an operator actually
// starts work. Specialist screens are owned by a parent page and surfaced by
// that page according to their kind, never as a third rail level.
const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Overview','/admin'],['attention','Needs attention','/admin/attention']]},
  {key:'customers',label:'Customers',pages:[['users','All customers','/admin/users'],['tickets','Support','/admin/tickets']]},
  {key:'servers',label:'Servers',pages:[['servers','Jellyfin','/admin/servers'],['stremio-sources','Stremio','/admin/servers/stremio'],['activity','Playback','/admin/activity']]},
  {key:'commerce',label:'Commerce',pages:[['plans','Plans','/admin/plans'],['orders','Orders','/admin/commerce/orders'],['payments','Payments','/admin/payments']]},
  {key:'operations',label:'Operations',pages:[['provisioning','Provisioning','/admin/provisioning'],['automation-jobs','Automation','/admin/automation'],['backups','Backups','/admin/backups']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['settings-security','Security','/admin/settings?section=security'],['settings-integrations','Connections','/admin/settings/integrations'],['system','System','/admin/system']]}
]);

const hiddenPages=Object.freeze({
  search:Object.freeze({kind:'page',groupKey:'dashboard',parentKey:'dashboard',page:Object.freeze(['search','Search','/admin/search'])}),
  attention:Object.freeze({kind:'page',groupKey:'dashboard',parentKey:'dashboard',page:Object.freeze(['attention','Needs Attention','/admin/attention'])}),

  'servers-dashboard':Object.freeze({kind:'view',groupKey:'servers',parentKey:'servers',page:Object.freeze(['servers-dashboard','Fleet dashboard','/admin/servers/dashboard'])}),
  'fleet-operations':Object.freeze({kind:'view',groupKey:'servers',parentKey:'servers',page:Object.freeze(['fleet-operations','Placement & capacity','/admin/servers/operations'])}),
  libraries:Object.freeze({kind:'page',groupKey:'servers',parentKey:'servers',page:Object.freeze(['libraries','Libraries','/admin/libraries'])}),
  'inactivity-policy':Object.freeze({kind:'setting',groupKey:'servers',parentKey:'activity',page:Object.freeze(['inactivity-policy','Free-user inactivity rules','/admin/activity/inactivity-policy'])}),

  'stremio-playback':Object.freeze({kind:'setting',groupKey:'servers',parentKey:'stremio-sources',page:Object.freeze(['stremio-playback','IP access','/admin/stremio/playback'])}),

  'users-dashboard':Object.freeze({kind:'view',groupKey:'customers',parentKey:'users',page:Object.freeze(['users-dashboard','Customer activity','/admin/users/dashboard'])}),
  'customer-claims':Object.freeze({kind:'task',groupKey:'customers',parentKey:'users',page:Object.freeze(['customer-claims','Imported-user claims','/admin/customer-claims'])}),
  'jellyfin-import':Object.freeze({kind:'task',groupKey:'customers',parentKey:'users',page:Object.freeze(['jellyfin-import','Import from Jellyfin','/admin/jellyfin-import'])}),
  'customer-jellyfin-password':Object.freeze({kind:'task',groupKey:'customers',parentKey:'users',page:Object.freeze(['customer-jellyfin-password','Jellyfin password support','/admin/customer-jellyfin-password'])}),

  'commerce-overview':Object.freeze({kind:'view',groupKey:'commerce',parentKey:'orders',page:Object.freeze(['commerce-overview','Analytics','/admin/commerce'])}),
  discounts:Object.freeze({kind:'page',groupKey:'commerce',parentKey:'orders',page:Object.freeze(['discounts','Discounts','/admin/discounts'])}),
  referrals:Object.freeze({kind:'page',groupKey:'commerce',parentKey:'orders',page:Object.freeze(['referrals','Affiliates','/admin/referrals'])}),
  marketing:Object.freeze({kind:'page',groupKey:'commerce',parentKey:'orders',page:Object.freeze(['marketing','Marketing','/admin/marketing'])}),
  'storefront-order':Object.freeze({kind:'setting',groupKey:'commerce',parentKey:'plans',page:Object.freeze(['storefront-order','Storefront order','/admin/plans/order'])}),
  'plan-access-rules':Object.freeze({kind:'setting',groupKey:'commerce',parentKey:'plans',page:Object.freeze(['plan-access-rules','Access rules','/admin/plans/access-rules'])}),
  billing:Object.freeze({kind:'page',groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),
  transactions:Object.freeze({kind:'view',groupKey:'commerce',parentKey:'payments',page:Object.freeze(['transactions','Imported payment archive','/admin/payments/transactions'])}),
  refunds:Object.freeze({kind:'setting',groupKey:'commerce',parentKey:'payments',page:Object.freeze(['refunds','Prepaid refunds','/admin/refunds'])}),
  expenses:Object.freeze({kind:'page',groupKey:'commerce',parentKey:'payments',page:Object.freeze(['expenses','Expenses & Profitability','/admin/expenses'])}),
  'provider-mappings':Object.freeze({kind:'setting',groupKey:'commerce',parentKey:'payments',page:Object.freeze(['provider-mappings','Provider mappings','/admin/provider-mappings'])}),
  'payment-risk-policy':Object.freeze({kind:'setting',groupKey:'commerce',parentKey:'payments',page:Object.freeze(['payment-risk-policy','Payment risk','/admin/payments/risk-policy'])}),

  // Portability/export is an operational backup/migration concern rather than a
  // day-to-day payment workflow, so it belongs to Backups context.
  'data-export':Object.freeze({kind:'task',groupKey:'operations',parentKey:'backups',page:Object.freeze(['data-export','Export data','/admin/payments/export'])}),

  'server-migrations':Object.freeze({kind:'task',groupKey:'operations',parentKey:'provisioning',page:Object.freeze(['server-migrations','Customer moves','/admin/provisioning/migrations'])}),
  'policy-drift':Object.freeze({kind:'task',groupKey:'operations',parentKey:'provisioning',page:Object.freeze(['policy-drift','Access consistency','/admin/provisioning/drift'])}),
  events:Object.freeze({kind:'page',groupKey:'operations',parentKey:'automation-jobs',page:Object.freeze(['events','Audit log','/admin/events'])}),
  'configuration-transfer':Object.freeze({kind:'task',groupKey:'operations',parentKey:'backups',page:Object.freeze(['configuration-transfer','Configuration Transfer','/admin/configuration'])}),
  'legacy-paid-import':Object.freeze({kind:'task',groupKey:'operations',parentKey:'backups',page:Object.freeze(['legacy-paid-import','Migrate paid users','/admin/payments/legacy-import'])}),

  'settings-commerce':Object.freeze({kind:'setting',groupKey:'commerce',parentKey:'plans',page:Object.freeze(['settings-commerce','Commerce settings','/admin/settings/commerce'])}),

  branding:Object.freeze({kind:'setting',groupKey:'settings',parentKey:'settings-general',page:Object.freeze(['branding','Branding','/admin/settings/branding'])}),
  'support-policy':Object.freeze({kind:'setting',groupKey:'settings',parentKey:'settings-general',page:Object.freeze(['support-policy','Support & legal','/admin/settings/support'])}),
  'abuse-protection':Object.freeze({kind:'setting',groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['abuse-protection','Turnstile & abuse protection','/admin/settings/abuse-protection'])}),
  'notification-settings':Object.freeze({kind:'setting',groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['notification-settings','Notifications','/admin/notifications/preferences'])}),
  'notification-gateway':Object.freeze({kind:'setting',groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['notification-gateway','Email infrastructure','/admin/notifications'])}),
  'request-service':Object.freeze({kind:'page',groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['request-service','Request service','/admin/request-users'])}),

  'my-profile':Object.freeze({kind:'page',groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-profile','My Profile','/admin/profile'])}),
  'my-notifications':Object.freeze({kind:'page',groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-notifications','My Notifications','/admin/profile/notifications'])}),
  'my-security':Object.freeze({kind:'page',groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['my-security','My Security','/admin/security'])}),
  'admin-2fa-policy':Object.freeze({kind:'setting',groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['admin-2fa-policy','Administrator 2FA','/admin/settings/admin-2fa'])})
});

const aliases=Object.freeze({
  'jellyfin-overview':'servers','stremio-overview':'stremio-sources',
  'jellyfin-plans':'plans','stremio-plans':'plans',
  'jellyfin-customers':'users','stremio-customers':'users',
  notifications:'notification-gateway','notification-events':'settings-integrations',
  'payment-reconciliation':'payments','configuration-health':'settings-general','setup':'settings-general','settings':'settings-general',
  'stremio-settings':'stremio-sources','stremio-source-pool':'stremio-sources','stremio-managed-sources':'stremio-sources',
  security:'my-security','operations':'servers',
  // Keys retired by the six-section rail. Old routes and any activeNav value
  // still in a template resolve to their new owner instead of falling back to
  // the first group.
  people:'users','jellyfin-import-users':'jellyfin-import','automation':'automation-jobs'
});

// The rail is flat: six sections, seventeen destinations, two levels. Nothing
// is ever added back to it. Every other page is surfaced by its parent page
// according to its kind, or found with the command palette:
//
//   view     a pivot of data the parent already shows -> a tab on the parent
//   task     a job you run occasionally               -> a row that opens a panel
//   setting  a handful of toggles                     -> a switch bank on the parent
//   page     a genuine destination                    -> a Related link + Cmd-K
//
// This is what keeps the depth ceiling at two clicks. If a page feels hard to
// find, the fix is a Related row on its parent or a better palette keyword --
// never a third level in the rail.
const SIDEBAR_EXCLUDED_CHILDREN=new Set(Object.keys(hiddenPages));

function activeKey(value){return aliases[value]||value||'dashboard';}
function sidebarKey(value){const key=activeKey(value);return hiddenPages[key]?.parentKey||key;}
function groupFor(active){const key=activeKey(active),hidden=hiddenPages[key];if(hidden){const base=groups.find(group=>group.key===hidden.groupKey)||groups[0],personal=['my-profile','my-notifications','my-security'].includes(key);return {...base,label:personal?'My account':base.label,pages:[hidden.page,...base.pages]};}return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];}
function workflowParentPage(active){const key=activeKey(active),hidden=hiddenPages[key];if(!hidden)return null;const base=groups.find(group=>group.key===hidden.groupKey);return base?.pages.find(page=>page[0]===hidden.parentKey)||null;}

function byKind(parentKey,kind){
  const parent=String(parentKey||'');
  return Object.values(hiddenPages)
    .filter(item=>item.parentKey===parent&&item.kind===kind)
    .map(item=>item.page);
}

// What a parent page renders. Each returns [key,label,url] triples.
function viewsFor(parentKey){return byKind(parentKey,'view');}
function tasksFor(parentKey){return byKind(parentKey,'task');}
function settingsFor(parentKey){return byKind(parentKey,'setting');}
function relatedPages(parentKey){return byKind(parentKey,'page');}

// The rail renders no children. Retained so existing callers keep working
// while pages migrate; it is intentionally always empty.
function childPages(){return[];}

function workflowPages(active){
  const key=activeKey(active),parentKey=sidebarKey(key),hidden=hiddenPages[key];
  if(parentKey.startsWith('my-'))return[];
  const groupKey=hidden?.groupKey||groups.find(group=>group.pages.some(page=>page[0]===parentKey))?.key;
  const group=groups.find(item=>item.key===groupKey);
  const parent=group?.pages.find(page=>page[0]===parentKey);
  if(!parent)return[];
  const children=[...viewsFor(parentKey),...relatedPages(parentKey)];
  return children.length?[parent,...children]:[];
}
function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}
for(const group of groups){for(const page of group.pages){if(!Object.prototype.hasOwnProperty.call(page,'children'))Object.defineProperty(page,'children',{value:Object.freeze([]),enumerable:false});}}
module.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,workflowParentPage,workflowPages,childPages,viewsFor,tasksFor,settingsFor,relatedPages,landingFor,SIDEBAR_EXCLUDED_CHILDREN};
