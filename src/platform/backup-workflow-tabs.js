'use strict';

function tabs(active='backups'){
  const items=[
    ['backups','Database backups','/admin/backups'],
    ['transfer','Configuration transfer','/admin/configuration']
  ];
  return `<div class="operatorTabs" aria-label="Backup and transfer workflow">${items.map(([key,text,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${text}</a>`).join('')}</div>`;
}
module.exports={tabs};
