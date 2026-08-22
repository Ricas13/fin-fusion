'use strict';

const ui=require('./admin-ui');

function tabs(active='provisioning'){
  return ui.workflowCards([
    ['provisioning','Provisioning','/admin/provisioning','Queue state, failures, retries and customer access creation'],
    ['migrations','Customer moves','/admin/provisioning/migrations','Controlled customer moves between Jellyfin servers'],
    ['drift','Access consistency','/admin/provisioning/drift','Detect and repair plan, account and access-policy drift']
  ],active,'Provisioning control room');
}
module.exports={tabs};
