'use strict';

const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin'],['attention','Needs Attention','/admin/attention'],['search','Search','/admin/search'],['events','Events','/admin/events']]},
  {key:'people',label:'People',pages:[['users','Customers','/admin/users'],['jellyfin-import','Jellyfin Import','/admin/jellyfin-import'],['customer-claims','Customer Claims','/admin/customer-claims'],['invitations','Invitations','/admin/invitations'],['resellers','Resellers','/admin/reseller-management'],['activity','Activity','/admin/activity']]},
  {key:'servers',label:'Servers',pages:[['servers','Servers','/admin/servers'],['libraries','Libraries','/admin/libraries']]},
  {key:'commerce',label:'Commerce',pages:[['commerce-overview','Overview','/admin/commerce'],['plans','Plans','/admin/plans'],['reseller-tiers','Reseller Plans','/admin/reseller-tiers'],['payments','Payments','/admin/payments'],['billing','Billing','/admin/billing'],['provider-mappings','Provider Mappings','/admin/provider-mappings'],['discounts','Discounts','/admin/discounts'],['referrals','Referrals','/admin/referrals']]},
  {key:'automation',label:'Automation',pages:[['provisioning','Provisioning','/admin/provisioning'],['policy-drift','Policy Drift','/admin/provisioning/drift'],['notifications','Notifications','/admin/notifications'],['notification-events','Event Delivery','/admin/notifications/preferences'],['automation-jobs','Jobs','/admin/automation']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['branding','Branding','/admin/settings/branding'],['settings-commerce','Commerce','/admin/settings?section=commerce'],['settings-integrations','Integrations','/admin/settings?section=integrations'],['settings-security','Security','/admin/settings?section=security'],['operations','Operations','/admin/operations'],['backups','Backups','/admin/backups'],['settings-advanced','Advanced','/admin/settings?section=advanced']]}
]);
const aliases=Object.freeze({
  'payment-reconciliation':'commerce-overview',
  'configuration-health':'settings-general',
  'setup':'settings-general',
  'settings':'settings-general',
  'support-policy':'settings-general',
  'reseller-settings':'settings-commerce',
  'stremio-settings':'settings-integrations',
  'abuse-protection':'settings-security',
  'configuration-transfer':'settings-advanced'
});
function activeKey(value){return aliases[value]||value||'dashboard';}
function groupFor(active){const key=activeKey(active);return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];}
module.exports={groups,aliases,activeKey,groupFor};
