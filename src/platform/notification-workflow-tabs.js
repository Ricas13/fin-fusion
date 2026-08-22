'use strict';

const ui=require('./admin-ui');

function globalTabs(active='global'){
  return ui.workflowCards([
    ['global','Global notifications','/admin/notifications/preferences','Global customer/admin events plus Telegram, Discord and WhatsApp'],
    ['email','Email infrastructure','/admin/notifications/email','SMTP delivery settings and connection validation'],
    ['health','Delivery health','/admin/notifications','Queue health, delivery failures and recent notification state']
  ],active,'Notification control room');
}

function profileTabs(active='profile'){
  return ui.workflowCards([
    ['profile','Profile','/admin/profile','Your administrator profile and account details'],
    ['personal','Notifications','/admin/profile/notifications','Your personal notification preferences'],
    ['security','Security','/admin/security','Password, authenticator, recovery codes and sessions']
  ],active,'My account');
}

function tabs(active='global'){
  return ['profile','personal','security'].includes(active)?profileTabs(active):globalTabs(active);
}

module.exports={tabs,globalTabs,profileTabs};
