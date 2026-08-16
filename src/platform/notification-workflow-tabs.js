'use strict';

function render(items,active,label){
  return `<div class="operatorTabs" aria-label="${label}">${items.map(([key,text,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${text}</a>`).join('')}</div>`;
}

function globalTabs(active='global'){
  return render([
    ['global','Global notifications','/admin/notifications/preferences'],
    ['email','Email infrastructure','/admin/notifications/email']
  ],active,'Notification settings workflow');
}

function profileTabs(active='profile'){
  return render([
    ['profile','Profile','/admin/profile'],
    ['personal','Notifications','/admin/profile/notifications']
  ],active,'My profile workflow');
}

// Compatibility for older callers. Global notification pages should use
// globalTabs(), while personal account pages should use profileTabs().
function tabs(active='global'){
  return ['profile','personal'].includes(active)?profileTabs(active):globalTabs(active);
}

module.exports={tabs,globalTabs,profileTabs};
