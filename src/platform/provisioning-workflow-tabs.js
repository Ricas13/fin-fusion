'use strict';

function tabs(active='provisioning'){
  const items=[
    ['provisioning','Provisioning','/admin/provisioning'],
    ['requests','Request service','/admin/request-users'],
    ['limits','Plan limits','/admin/request-plan-policy'],
    ['migrations','Server migrations','/admin/provisioning/migrations'],
    ['drift','Policy drift','/admin/provisioning/drift']
  ];
  return `<div class="operatorTabs" aria-label="Provisioning workflow">${items.map(([key,text,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${text}</a>`).join('')}</div>`;
}

module.exports={tabs};
