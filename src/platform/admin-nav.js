'use strict';

// Keep the primary navigation task-oriented. Diagnostic and implementation
// pages remain addressable, but live inside the workflow that owns them rather
// than competing with everyday destinations in the sidebar.
const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin'],['attention','Needs Attention','/admin/attention'],['search','Search','/admin/search']]},
  {key:'people',label:'People',pages:[['users','Customers','/admin/users'],['resellers','Resellers','/admin/reseller-management'],['activity','Playback & Activity','/admin/activity']]},
  {key:'servers',label:'Servers',pages:[['servers','Servers','/admin/servers'],['libraries','Libraries','/admin/libraries']]},
  {key:'commerce',label:'Commerce',pages:[['commerce-overview','Overview','/admin/commerce'],['plans','Plans','/admin/plans'],['payments','Payments','/admin/payments'],['discounts','Discounts','/admin/discounts'],['referrals','Referrals','/admin/referrals']]},
  {key:'automation',label:'Automation',pages:[['provisioning','Provisioning','/admin/provisioning'],['automation-jobs','Jobs','/admin/automation'],['events','Audit & events','/admin/events']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['my-profile','My Profile','/admin/profile'],['notification-settings','Notifications','/admin/notifications/preferences'],['branding','Branding','/admin/settings/branding'],['settings-integrations','Integrations','/admin/settings?section=integrations'],['settings-security','Security','/admin/settings?section=security'],['operations','Operations','/admin/operations'],['backups','Backups & Transfer','/admin/backups']]}
]);

// Workflow pages can stay grouped/breadcrumbed without consuming sidebar space.
// parentKey keeps the owning sidebar destination highlighted while the breadcrumb
// and top workflow tabs describe the more specific page.
const hiddenPages=Object.freeze({
  billing:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['billing','Billing','/admin/billing'])}),
  'my-notifications':Object.freeze({groupKey:'settings',parentKey:'my-profile',page:Object.freeze(['my-notifications','My Notifications','/admin/profile/notifications'])}),
  'request-service':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['request-service','Request service','/admin/request-users'])}),
  'request-plan-limits':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['request-plan-limits','Plan limits','/admin/request-plan-policy'])}),
  'server-migrations':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['server-migrations','Server migrations','/admin/provisioning/migrations'])}),
  'policy-drift':Object.freeze({groupKey:'automation',parentKey:'provisioning',page:Object.freeze(['policy-drift','Policy drift','/admin/provisioning/drift'])}),
  'notification-gateway':Object.freeze({groupKey:'settings',parentKey:'notification-settings',page:Object.freeze(['notification-gateway','Delivery health','/admin/notifications'])}),
  'configuration-transfer':Object.freeze({groupKey:'settings',parentKey:'backups',page:Object.freeze(['configuration-transfer','Configuration Transfer','/admin/configuration'])})
});

const aliases=Object.freeze({
  'customer-claims':'users','reseller-tiers':'plans','provider-mappings':'payments','notifications':'notification-settings','notification-events':'notification-settings','payment-reconciliation':'commerce-overview','configuration-health':'settings-general','setup':'settings-general','settings':'settings-general','support-policy':'settings-general','reseller-settings':'settings-general','stremio-settings':'settings-integrations','abuse-protection':'settings-security','jellyfin-import':'servers','invitations':'plans'
});
function activeKey(value){return aliases[value]||value||'dashboard';}
function sidebarKey(value){const key=activeKey(value);return hiddenPages[key]?.parentKey||key;}
function groupFor(active){
  const key=activeKey(active),hidden=hiddenPages[key];
  if(hidden){const base=groups.find(group=>group.key===hidden.groupKey)||groups[0];return {...base,pages:[hidden.page,...base.pages]};}
  return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];
}
function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}
module.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,landingFor};
