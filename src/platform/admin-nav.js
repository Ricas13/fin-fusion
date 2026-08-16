'use strict';

// Keep the navigation task-oriented. Technical implementation pages remain
// addressable for compatibility, but are surfaced from the workflow that owns
// them instead of competing for sidebar space.
const groups=Object.freeze([
  {key:'dashboard',label:'Dashboard',pages:[['dashboard','Dashboard','/admin'],['attention','Needs Attention','/admin/attention'],['search','Search','/admin/search'],['events','Events','/admin/events']]},
  {key:'people',label:'People',pages:[['users','Customers','/admin/users'],['resellers','Resellers','/admin/reseller-management'],['activity','Playback & Activity','/admin/activity']]},
  {key:'servers',label:'Servers',pages:[['servers','Servers','/admin/servers'],['libraries','Libraries','/admin/libraries']]},
  {key:'commerce',label:'Commerce',pages:[['commerce-overview','Overview','/admin/commerce'],['plans','Plans','/admin/plans'],['payments','Payments','/admin/payments'],['discounts','Discounts','/admin/discounts'],['referrals','Referrals','/admin/referrals']]},
  {key:'automation',label:'Automation',pages:[['provisioning','Provisioning','/admin/provisioning'],['policy-drift','Policy Drift','/admin/provisioning/drift'],['notification-gateway','Notification gateway','/admin/notifications'],['automation-jobs','Jobs','/admin/automation']]},
  {key:'settings',label:'Settings',pages:[['settings-general','General','/admin/settings?section=general'],['my-profile','My Profile','/admin/profile'],['notification-settings','Notifications','/admin/notifications/preferences'],['branding','Branding','/admin/settings/branding'],['settings-integrations','Integrations','/admin/settings?section=integrations'],['settings-security','Security','/admin/settings?section=security'],['operations','Operations','/admin/operations'],['backups','Backups','/admin/backups'],['settings-advanced','Advanced','/admin/settings?section=advanced']]}
]);

// Workflow pages can stay grouped/breadcrumbed without consuming sidebar space.
// Billing is reached from the Commerce workflow tabs, and personal notification
// routing is reached from My Profile rather than duplicated in the sidebar.
const hiddenPages=Object.freeze({
  billing:Object.freeze({groupKey:'commerce',page:Object.freeze(['billing','Billing','/admin/billing'])}),
  'my-notifications':Object.freeze({groupKey:'settings',page:Object.freeze(['my-notifications','My Notifications','/admin/profile/notifications'])})
});

const aliases=Object.freeze({
  'customer-claims':'users',
  'reseller-tiers':'plans',
  'provider-mappings':'payments',
  'notifications':'notification-settings',
  'notification-events':'notification-settings',
  'payment-reconciliation':'commerce-overview',
  'configuration-health':'settings-general',
  'setup':'settings-general',
  'settings':'settings-general',
  'support-policy':'settings-general',
  'reseller-settings':'settings-general',
  'stremio-settings':'settings-integrations',
  'abuse-protection':'settings-security',
  'configuration-transfer':'settings-advanced',
  'jellyfin-import':'servers',
  'invitations':'plans'
});
function activeKey(value){return aliases[value]||value||'dashboard';}
function groupFor(active){
  const key=activeKey(active),hidden=hiddenPages[key];
  if(hidden){
    const base=groups.find(group=>group.key===hidden.groupKey)||groups[0];
    return {...base,pages:[hidden.page,...base.pages]};
  }
  return groups.find(group=>group.pages.some(page=>page[0]===key))||groups[0];
}
function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}
module.exports={groups,hiddenPages,aliases,activeKey,groupFor,landingFor};
