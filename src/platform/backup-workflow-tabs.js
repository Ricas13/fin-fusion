'use strict';

const ui=require('./admin-ui');

function tabs(active='backups'){
  return ui.workflowCards([
    ['backups','Database backups','/admin/backups','Backup readiness, verification, off-host copies and restore runbook'],
    ['transfer','Configuration transfer','/admin/configuration','Export and import portable CAPTAiNFiN configuration']
  ],active,'Backup and recovery control room');
}
module.exports={tabs};
