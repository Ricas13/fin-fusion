'use strict';

function tabs(active='setup'){
  const items=[
    ['setup','Payment setup','/admin/payments'],
    ['mappings','Provider mappings','/admin/provider-mappings'],
    ['billing','Billing','/admin/billing']
  ];
  return `<div class="operatorTabs" aria-label="Payment workflow">${items.map(([key,label,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${label}</a>`).join('')}</div>`;
}
module.exports={tabs};
