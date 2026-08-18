'use strict';

function tabs(active='integrations'){
  const items=[
    ['integrations','Integrations','/admin/settings?section=integrations'],
    ['requests','Request service','/admin/request-users']
  ];
  return `<div class="operatorTabs" aria-label="Integration workflow">${items.map(([key,label,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${label}</a>`).join('')}</div>`;
}
module.exports={tabs};
