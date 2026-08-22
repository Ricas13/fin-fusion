'use strict';

const ui=require('./admin-ui');

function tabs(active='integrations'){
  if(active==='limits')return'';
  return ui.workflowCards([
    ['integrations','Integrations','/admin/settings?section=integrations','Payment, email, notification and external-service configuration'],
    ['requests','Request service','/admin/request-users','Request-service connection and customer synchronisation']
  ],active,'Integration workflow');
}
module.exports={tabs};
