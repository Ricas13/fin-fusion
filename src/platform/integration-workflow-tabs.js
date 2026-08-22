'use strict';

const ui=require('./admin-ui');

function tabs(active='integrations'){
  if(active==='limits')return'';
  return ui.workflowCards([
    ['integrations','Connections','/admin/settings/integrations','Overall readiness for payment, email, messaging and request-service integrations'],
    ['notifications','Notifications','/admin/notifications/preferences','Global customer/admin events plus messaging channels'],
    ['email','Email infrastructure','/admin/notifications/email','SMTP delivery settings and connection validation'],
    ['health','Delivery health','/admin/notifications','Queue health, delivery failures and recent notification state'],
    ['requests','Request service','/admin/request-users','Request-service connection and customer synchronisation']
  ],active,'Connections control room');
}
module.exports={tabs};
