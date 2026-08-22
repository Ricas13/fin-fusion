'use strict';

const ui=require('./admin-ui');

function tabs(active='integrations'){
  if(active==='limits')return'';
  return ui.workflowCards([
    ['integrations','Connections','/admin/settings?section=integrations','Payment, email, notification and external-service readiness'],
    ['requests','Request service','/admin/request-users','Request-service connection and customer synchronisation']
  ],active,'Connections control room');
}
module.exports={tabs};
