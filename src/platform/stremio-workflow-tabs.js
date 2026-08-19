'use strict';

function tabs(active='manage'){
  const items=[
    ['manage','Manage Stremio','/admin/servers/stremio/managed'],
    ['external','External Sources','/admin/servers/stremio']
  ];
  return `<div class="operatorTabs" aria-label="Stremio management">${items.map(([key,label,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${label}</a>`).join('')}</div>`;
}

module.exports={tabs};
