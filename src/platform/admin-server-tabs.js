'use strict';

const {esc}=require('./admin-html');

function serverTabs(serverId,active='configuration'){
  const id=encodeURIComponent(String(serverId));
  const items=[
    ['configuration','Configuration',`/admin/servers/${id}/edit`],
    ['libraries','Libraries',`/admin/libraries?serverId=${id}`],
    ['users','Users / Import',`/admin/servers/${id}/users`]
  ];
  return `<div class="operatorTabs serverOperatorTabs">${items.map(([key,label,url])=>`<a class="operatorTab ${key===active?'active':''}" href="${esc(url)}">${esc(label)}</a>`).join('')}</div>`;
}

module.exports={serverTabs};
