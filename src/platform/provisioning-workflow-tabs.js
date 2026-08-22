'use strict';

function tabs(active='provisioning'){
  const items=[
    ['provisioning','Provisioning','/admin/provisioning'],
    ['migrations','Customer moves','/admin/provisioning/migrations'],
    ['drift','Access consistency','/admin/provisioning/drift']
  ];
  return `<div class="operatorTabs" aria-label="Provisioning workflow">${items.map(([key,label,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${label}</a>`).join('')}</div>`;
}
module.exports={tabs};
