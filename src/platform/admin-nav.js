'use strict';

const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin'],['attention','Needs Attention','/admin/attention']]},
  {key:'people',label:'Customers',pages:[['users-dashboard','Overview','/admin/users/dashboard'],['users','Customers','/admin/users'],['tickets','Tickets','/admin/tickets'],['jellyfin-import','Import Jellyfin users','/admin/jellyfin-import']]},
  {key:'servers',label:'Delivery',pages:[['stremio-sources','Stremio','/admin/servers/stremio/managed'],['servers-dashboard','Overview','/admin/servers/dashboard'],['servers','Jellyfin servers','/admin/servers'],['activity','Playback','/admin/activity']]},
  {key:'commerce',label:'Plans & Payments',pages:[['commerce-overview','Overview','/admin/commerce'],['orders','Orders','/admin/orders'],['plans','Plans','/admin/plans'],['payments','Payments','/admin/payments']]},
  {key:'automation',label:'Operations',pages:[['provisioning','Provisioning','/admin/provisioning'],['automation-jobs','Jobs','/admin/automation'],['events','Audit log','/admin/events'],['backups','Backups','/admin/backups']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['branding','Branding','/admin/settings/branding'],['support-policy','Support & legal','/admin/settings/support'],['settings-security','Security','/admin/settings?section=security'],['notification-settings','Notifications','/admin/notifications/preferences'],['settings-integrations','Integrations','/admin/settings?section=integrations']]}
]);
const hiddenPages=Object.freeze({
  search:Object.freeze({groupKey:'dashboard',parentKey:'dashboard',page:Object.freeze(['search','Search','/admin/search'])}),
  billing:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),
  'customer-claims':Object.freeze({groupKey:'people',parentKey:'jellyfin-import',page:Object.freeze(['customer-claims','Imported-user claims','/admin/customer-claims'])}),
  'customer-jellyfin-password':Object.freeze({groupKey:'people',parentKey:'users',page:Object.freeze(['customer-jellyfin-password','Jellyfin password support','/admin/customer-jellyfin-password'])}),
  'my-profile':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-profile','My Profile','/admin/profile'])}),
  'my-notifications':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-notifications','My Notifications','/admin/profile/notifications'])}),
  'my-security':Object.freeze({groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['my-security','My Security','/admin/security'])}),
  'admin-2fa-policy':Object.freeze({groupKey:'settings',parentKey:'settings-security',page:Object.freeze(['admin-2fa-policy','Administrator 2FA','/admin/settings/admin-2fa'])}),
  'request-service':Object.freeze({groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['request-service','Request service','/admin/request-users'])}),
  'request-plan-limits':Object.freeze({groupKey:'settings',parentKey:'settings-integrations',page:Object.freeze(['request-plan-limits','Request limits','/admin/request-plan-policy'])}),
  'plan-access-rules':Object.freeze({groupKey:'commerce',parentKey:'plans',page:Object.freeze(['plan-access-rules','Access rules','/admin/plans/access-rules'])}),
  discounts:Object.freeze({groupKey:'commerce',parentKey:'plans',page:Object.freeze(['discounts','Discounts','/admin/discounts'])}),
  marketing:Object.freeze({groupKey:'commerce',parentKey:'commerce-overview',page:Object.freeze(['marketing','Marketing','/admin/marketing'])}),
  referrals:Object.freeze({groupKey:'commerce',parentKey:'commerce-overview',page:Object.freeze(['referrals','Affiliates','/admin/referrals'])}),
  'payment-risk-policy':Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['payment-risk-policy','Payment risk','/admin/payments/risk-policy'])}),
  libraries:Object.freeze({groupKey:'servers',parentKey:'servers',page:Object.freeze(['libraries','Libraries','/admin/libraries'])}),
  'server-migrations':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['server-migrations','Server migrations','/admin/provisioning/migrations'])}),
  'policy-drift':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['policy-drift','Policy drift','/admin/provisioning/drift'])}),
  'notification-gateway':Object.freeze({groupKey:'settings',parentKey:'notification-settings',page:Object.freeze(['notification-gateway','Delivery health','/admin/notifications'])}),
  'fleet-operations':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['fleet-operations','Fleet operations','/admin/servers/operations'])}),
  'configuration-transfer':Object.freeze({groupKey:'automation',parentKey:'backups',page:Object.freeze(['configuration-transfer','Configuration Transfer','/admin/configuration'])})
});
const aliases=Object.freeze({
  'provider-mappings':'payments','notifications':'notification-settings','notification-events':'notification-settings','payment-reconciliation':'payments','configuration-health':'settings-general','setup':'settings-general','settings':'settings-general','stremio-settings':'stremio-sources','stremio-source-pool':'stremio-sources','stremio-managed-sources':'stremio-sources','abuse-protection':'settings-security','security':'my-security','operations':'fleet-operations'
});
function activeKey(value){return aliases[value]||value||'dashboard';}
function sidebarKey(value){const key=activeKey(value);return hiddenPages[key]?.parentKey||key;}
function groupFor(active){const key=activeKey(active),hidden=hiddenPages[key];if(hidden){const base=groups.find(group=>group.key===hidden.groupKey)||groups[0],personal=['my-profile','my-notifications','my-security'].includes(key);return {...base,label:personal?'My account':base.label,pages:[hidden.page,...base.pages]};}return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];}
function workflowParentPage(active){const key=sidebarKey(active),hidden=hiddenPages[key];return hidden?.page||null;}
function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}
module.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,workflowParentPage,landingFor};
