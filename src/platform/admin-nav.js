'use strict';

// Keep the permanent sidebar focused on the few places an operator actually
// starts work. Specialist screens remain routable as hidden workflow pages so
// bookmarks, deep links and focused investigation flows do not break.
const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin']]},
  {key:'jellyfin',label:'Jellyfin',pages:[['servers','Servers','/admin/servers'],['activity','Playback','/admin/activity']]},
  {key:'stremio',label:'Stremio',pages:[['stremio-sources','Stremio','/admin/servers/stremio']]},
  {key:'resellers',label:'Resellers',pages:[['reseller-overview','Resellers','/admin/resellers']]},
  {key:'people',label:'Customers',pages:[['users','Customers','/admin/users'],['tickets','Support','/admin/tickets']]},
  {key:'commerce',label:'Commerce',pages:[['plans','Plans & Storefront','/admin/plans'],['orders','Orders & Growth','/admin/orders'],['payments','Payments & Billing','/admin/payments']]},
  {key:'automation',label:'Operations',pages:[['provisioning','Provisioning','/admin/provisioning'],['automation-jobs','Automation','/admin/automation'],['backups','Backups & Recovery','/admin/backups']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['settings-security','Security','/admin/settings?section=security'],['settings-integrations','Connections','/admin/settings/integrations'],['system','System','/admin/system']]}
]);

const hiddenPages=Object.freeze({
  search:Object.freeze({groupKey:'dashboard',parentKey:'dashboard',page:Object.freeze(['search','Search','/admin/search'])}),
  attention:Object.freeze({groupKey:'dashboard',parentKey:'dashboard',page:Object.freeze(['attention','Needs Attention','/admin/attention'])}),

  'stremio-playback':Object.freeze({groupKey:'stremio',parentKey:'stremio-sources',page:Object.freeze(['stremio-playback','IP access','/admin/stremio/playback'])}),

  'reseller-accounts':Object.freeze({groupKey:'resellers',parentKey:'reseller-overview',page:Object.freeze(['reseller-accounts','Reseller accounts','/admin/resellers/resellers'])}),
  'users-dashboard':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['users-dashboard','Customer activity','/admin/users/dashboard'])}),
  'customer-claims':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['customer-claims','Imported-user claims','/admin/customer-claims'])}),
  'jellyfin-import':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['jellyfin-import','Import from Jellyfin','/admin/jellyfin-import'])}),
  'customer-jellyfin-password':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['customer-jellyfin-password','Jellyfin password support','/admin/customer-jellyfin-password'])}),

  'commerce-overview':Object.freeze({groupKey:'commerce',parentKey:'orders',page:Object.freeze(['commerce-overview','Commerce analytics','/admin/commerce'])}),
  discounts:Object.freeze({groupKey:'commerce',parentKey:'orders',page:Object.freeze(['discounts','Discounts','/admin/discounts'])}),
  referrals:Object.freeze({groupKey:'commerce',parentKey:'orders',page:Object.freeze(['referrals','Affiliates','/admin/referrals'])}),
  'storefront-order':Object.freeze({groupKey:'commerce',parentKey:'plans',page:Object.freeze(['storefront-order','Storefront order','/admin/plans/order'])}),
  'plan-access-rules':Object.freeze({groupKey:'commerce',parentKey:'plans',page:Object.freeze(['plan-access-rules','Access rules','/admin/plans/access-rules'])}),
  billing:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),
  'provider-mappings':Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['provider-mappings','Provider mappings','/admin/provider-mappings'])}),
  'payment-risk-policy':Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['payment-risk-policy','Payment risk','/admin/payments/risk-policy'])}),

  'server-migrations':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['server-migrations','Customer moves','/admin/provisioning/migrations'])}),
  'policy-drift':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['policy-drift','Access consistency','/admin/provisioning/drift'])}),
  events:Object.freeze({groupKey:'automation',parentKey:'automation-jobs',page:Object.freeze(['events','Audit log','/admin/events'])}),
  'configuration-transfer':Object.freeze({groupKey:'automation',parentKey:'backups',page:Object.freeze(['configuration-transfer','Configuration Transfer','/admin/configuration'])}),

  branding:Object.freeze({groupKey:'settings',parentKey:'settings-general',page:Object.freeze(['branding','Branding','/admin/settings/branding'])}),
  'support-policy':Object.freeze({groupKey:'settings',parentKey:'settings-general',page:Object.freeze(['support-policy','Support & legal','/admin/settings/support'])}),
  'notification-settings':Object.freeze({groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['notification-settings','Notifications','/admin/notifications/preferences'])}),
  'notification-gateway':Object.freeze({groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['notification-gateway','Delivery health','/admin/notifications'])}),
  'request-service':Object.freeze({groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['request-service','Request service','/admin/request-users'])}),

  'my-profile':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-profile','My Profile','/admin/profile'])}),
  'my-notifications':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-notifications','My Notifications','/admin/profile/notifications'])}),
  'my-security':Object.freeze({groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['my-security','My Security','/admin/security'])}),
  'admin-2fa-policy':Object.freeze({groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['admin-2fa-policy','Administrator 2FA','/admin/settings/admin-2fa'])})
});

const aliases=Object.freeze({
  'jellyfin-overview':'servers','stremio-overview':'stremio-sources',
  'jellyfin-plans':'plans','stremio-plans':'plans','reseller-plans':'plans',
  'jellyfin-customers':'users','stremio-customers':'users','reseller-users':'users',
  'reseller-servers':'reseller-overview','reseller-activity':'reseller-overview',
  notifications:'settings-integrations','notification-events':'settings-integrations',
  'payment-reconciliation':'payments','configuration-health':'settings-general','setup':'settings-general','settings':'settings-general',
  'stremio-settings':'stremio-sources','stremio-source-pool':'stremio-sources','stremio-managed-sources':'stremio-sources',
  'abuse-protection':'settings-security','security':'my-security','operations':'servers','servers-dashboard':'servers',
  'fleet-operations':'servers','libraries':'servers'
});

function activeKey(value){return aliases[value]||value||'dashboard';}
function sidebarKey(value){const key=activeKey(value);return hiddenPages[key]?.parentKey||key;}
function groupFor(active){const key=activeKey(active),hidden=hiddenPages[key];if(hidden){const base=groups.find(group=>group.key===hidden.groupKey)||groups[0],personal=['my-profile','my-notifications','my-security'].includes(key);return {...base,label:personal?'My account':base.label,pages:[hidden.page,...base.pages]};}return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];}
function workflowParentPage(active){const key=activeKey(active),hidden=hiddenPages[key];if(!hidden)return null;const base=groups.find(group=>group.key===hidden.groupKey);return base?.pages.find(page=>page[0]===hidden.parentKey)||null;}
function workflowPages(active){
  const key=activeKey(active),parentKey=sidebarKey(key),hidden=hiddenPages[key];
  if(parentKey.startsWith('my-'))return[];
  const groupKey=hidden?.groupKey||groups.find(group=>group.pages.some(page=>page[0]===parentKey))?.key;
  const group=groups.find(item=>item.key===groupKey);
  const parent=group?.pages.find(page=>page[0]===parentKey);
  if(!parent)return[];
  const children=Object.values(hiddenPages).filter(item=>item.groupKey===groupKey&&item.parentKey===parentKey&&item.page[0]!=='search').map(item=>item.page);
  return children.length?[parent,...children]:[];
}
function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}
module.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,workflowParentPage,workflowPages,landingFor};