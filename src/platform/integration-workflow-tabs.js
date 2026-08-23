'use strict';

const ui=require('./admin-ui');

const CONNECTIONS_TABS=Object.freeze([
  ['connections','Connections','/admin/settings/integrations','Overall readiness for payment, email, messaging and request-service integrations'],
  ['notifications','Notifications','/admin/notifications/preferences','Messaging applications, global events and secondary-channel delivery'],
  ['email','Email infrastructure','/admin/notifications','SMTP configuration, transactional delivery and retry health'],
  ['requests','Request service','/admin/request-users','Request-service connection and customer synchronisation']
]);

function normalize(active){
  return ({integrations:'connections',global:'notifications',health:'notifications'})[String(active||'')]||String(active||'connections');
}
function tabs(active='connections'){
  if(active==='limits')return'';
  return ui.workflowCards(CONNECTIONS_TABS,normalize(active),'Connections control room');
}
module.exports={tabs,normalize,CONNECTIONS_TABS};
