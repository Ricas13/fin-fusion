'use strict';

const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin'],['attention','Needs Attention','/admin/attention'],['search','Search','/admin/search'],['events','Events','/admin/events']]},
  {key:'people',label:'People',pages:[['users','Customers','/admin/users'],['jellyfin-import','Jellyfin Import','/admin/jellyfin-import'],['customer-claims','Customer Claims','/admin/customer-claims'],['invitations','Invitations','/admin/invitations'],['resellers','Resellers','/admin/reseller-management'],['activity','Activity','/admin/activity']]},
  {key:'servers',label:'Servers',pages:[['servers','Servers','/admin/servers'],['libraries','Libraries','/admin/libraries']]},
  {key:'commerce',label:'Commerce',pages:[['commerce-overview','Overview','/admin/commerce'],['plans','Plans','/admin/plans'],['reseller-tiers','Reseller Plans','/admin/reseller-tiers'],['payments','Payments','/admin/payments'],['billing','Billing','/admin/billing'],['discounts','Discounts','/admin/discounts'],['referrals','Referrals','/admin/referrals']]},
  {key:'automation',label:'Automation',pages:[['provisioning','Provisioning','/admin/provisioning'],['policy-drift','Policy Drift','/admin/provisioning/drift'],['notifications','Notifications','/admin/notifications'],['notification-events','Event Delivery','/admin/notifications/preferences'],['automation-jobs','Jobs','/admin/automation']]},
  {key:'settings',label:'Settings',pages:[['setup','Setup','/admin/setup'],['settings','General','/admin/settings'],['branding','Branding','/admin/settings/branding'],['operations','Operations','/admin/operations'],['reseller-settings','Reseller Settings','/admin/settings/resellers'],['configuration-transfer','Configuration Transfer','/admin/configuration'],['configuration-health','Configuration Health','/admin/configuration-health'],['backups','Backups','/admin/backups'],['support-policy','Support & Legal','/admin/settings/support']]}
]);
const aliases=Object.freeze({});
function activeKey(value){return aliases[value]||value||'dashboard'}
function groupFor(active){const key=activeKey(active);return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0]}
module.exports={groups,aliases,activeKey,groupFor};
