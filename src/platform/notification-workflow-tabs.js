'use strict';

const ui=require('./admin-ui');
const connectionsWorkflow=require('./integration-workflow-tabs');

function globalTabs(active='notifications'){
  return connectionsWorkflow.tabs(active);
}

function profileTabs(active='profile'){
  return ui.workflowCards([
    ['profile','Profile','/admin/profile','Your administrator profile and account details'],
    ['personal','Notifications','/admin/profile/notifications','Your personal notification preferences'],
    ['security','Security','/admin/security','Password, authenticator, recovery codes and sessions']
  ],active,'My account');
}

function tabs(active='notifications'){
  return ['profile','personal','security'].includes(active)?profileTabs(active):globalTabs(active);
}

module.exports={tabs,globalTabs,profileTabs};
