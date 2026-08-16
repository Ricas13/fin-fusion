'use strict';

function tabs(active='global'){
  const items=[
    ['global','Global notifications','/admin/notifications/preferences'],
    ['email','Email infrastructure','/admin/notifications/email'],
    ['personal','My notifications','/admin/profile/notifications'],
    ['profile','My profile','/admin/profile']
  ];
  return `<div class="operatorTabs" aria-label="Notification workflow">${items.map(([key,label,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${label}</a>`).join('')}</div>`;
}

module.exports={tabs};
