'use strict';

function render(items,active,label){
  return `<div class="operatorTabs" aria-label="${label}">${items.map(([key,text,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${text}</a>`).join('')}</div>`;
}

function globalTabs(active='global'){
  return render([
    ['global','Global notifications','/admin/notifications/preferences'],
    ['email','Email infrastructure','/admin/notifications/email'],
    ['health','Delivery health','/admin/notifications']
  ],active,'Notification settings workflow');
}

function profileTabs(active='profile'){
  return render([
    ['profile','Profile','/admin/profile'],
    ['personal','Notifications','/admin/profile/notifications'],
    ['security','Security','/admin/security']
  ],active,'My profile workflow');
}

function tabs(active='global'){
  return ['profile','personal','security'].includes(active)?profileTabs(active):globalTabs(active);
}

module.exports={tabs,globalTabs,profileTabs};
