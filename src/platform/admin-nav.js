'use strict';

const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin'],['attention','Needs Attention','/admin/attention']]},
  {key:'jellyfin',label:'Jellyfin',pages:[['jellyfin-overview','Overview','/admin/jellyfin'],['servers','Servers','/admin/servers'],['fleet-operations','Fleet operations','/admin/servers/operations'],['activity','Playback operations','/admin/activity']]},
  {key:'stremio',label:'Stremio',pages:[['stremio-overview','Overview','/admin/stremio'],['stremio-sources','Sources','/admin/servers/stremio'],['stremio-playback','IP access','/admin/stremio/playback']]},
  {key:'resellers',label:'Resellers',pages:[['reseller-overview','Overview','/admin/resellers'],['reseller-accounts','Resellers','/admin/resellers/resellers']]},
  {key:'people',label:'Customers',pages:[['users','All customers','/admin/users'],['tickets','Support','/admin/tickets'],['users-dashboard','Activity','/admin/users/dashboard']]},
  {key:'commerce',label:'Commerce',pages:[['commerce-overview','Overview','/admin/commerce'],['plans','Plans','/admin/plans'],['orders','Orders','/admin/orders'],['payments','Payments','/admin/payments'],['discounts','Discounts','/admin/discounts'],['referrals','Affiliates','/admin/referrals'],['storefront-order','Storefront order','/admin/plans/order']]},
  {key:'automation',label:'Operations',pages:[['provisioning','Provisioning','/admin/provisioning'],['automation-jobs','Jobs','/admin/automation'],['events','Audit log','/admin/events'],['backups','Backups','/admin/backups']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['system','System','/admin/system'],['branding','Branding','/admin/settings/branding'],['support-policy','Support & legal','/admin/settings/support'],['settings-security','Security','/admin/settings?section=security'],['notification-settings','Notifications','/admin/notifications/preferences'],['settings-integrations','Integrations','/admin/settings/integrations']]}
]);
const hiddenPages=Object.freeze({
  search:Object.freeze({groupKey:'dashboard',parentKey:'dashboard',page:Object.freeze(['search','Search','/admin/search'])}),
  billing:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),
  'customer-claims':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['customer-claims','Imported-user claims','/admin/customer-claims'])}),
  'jellyfin-import':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['jellyfin-import','Import Jellyfin users','/admin/jellyfin-import'])}),
  'customer-jellyfin-password':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['customer-jellyfin-password','Jellyfin password support','/admin/customer-jellyfin-password'])}),
  'my-profile':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-profile','My Profile','/admin/profile'])}),
  'my-notifications':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-notifications','My Notifications','/admin/profile/notifications'])}),
  'my-security':Object.freeze({groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['my-security','My Security','/admin/security'])}),
  'admin-2fa-policy':Object.freeze({groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['admin-2fa-policy','Administrator 2FA','/admin/settings/admin-2fa'])}),
  'request-service':Object.freeze({groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['request-service','Request service','/admin/request-users'])}),
  'request-plan-limits':Object.freeze({groupKey:'commerce',parentKey:'plans',page:Object.freeze(['request-plan-limits','Request limits','/admin/request-plan-policy'])}),
  'plan-access-rules':Object.freeze({groupKey:'commerce',parentKey:'plans',page:Object.freeze(['plan-access-rules','Access rules','/admin/plans/access-rules'])}),
  'payment-risk-policy':Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['payment-risk-policy','Payment risk','/admin/payments/risk-policy'])}),
  libraries:Object.freeze({groupKey:'jellyfin',parentKey:'servers',page:Object.freeze(['libraries','Libraries','/admin/libraries'])}),
  'server-migrations':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['server-migrations','Server migrations','/admin/provisioning/migrations'])}),
  'policy-drift':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['policy-drift','Policy drift','/admin/provisioning/drift'])}),
  'notification-gateway':Object.freeze({groupKey:'settings',parentKey:'notification-settings',page:Object.freeze(['notification-gateway','Delivery health','/admin/notifications'])}),
  'configuration-transfer':Object.freeze({groupKey:'automation',parentKey:'backups',page:Object.freeze(['configuration-transfer','Configuration Transfer','/admin/configuration'])})
});
const aliases=Object.freeze({
  'jellyfin-plans':'plans','stremio-plans':'plans','reseller-plans':'plans',
  'jellyfin-customers':'users','stremio-customers':'users','reseller-users':'users',
  'provider-mappings':'payments','notifications':'notification-settings','notification-events':'notification-settings','payment-reconciliation':'payments','configuration-health':'settings-general','setup':'settings-general','settings':'settings-general','stremio-settings':'stremio-sources','stremio-source-pool':'stremio-sources','stremio-managed-sources':'stremio-sources','abuse-protection':'settings-security','security':'my-security','operations':'fleet-operations','servers-dashboard':'jellyfin-overview'
});
function activeKey(value){return aliases[value]||value||'dashboard';}
function sidebarKey(value){const key=activeKey(active);return hiddenPages[key]?.parentKey||key;}
function groupFor(active){const key=activeKey(active),hidden=hiddenPages[key];if(hidden){const base=groups.find(group=>group.key===hidden.groupKey)||groups[0],personal=['my-profile','my-notifications','my-security'].includes(key);return {...base,label:personal?'My account':base.label,pages:[hidden.page,...base.pages]};}return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];}
function workflowParentPage(active){const key=sidebarKey(active),hidden=hiddenPages[key];return hidden?.page||null;}
function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}
module.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,workflowParentPage,landingFor};
