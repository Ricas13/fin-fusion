'use strict';

const ui=require('./admin-ui');

function serverTabs(serverId,active='configuration'){
  const id=encodeURIComponent(String(serverId));
  return ui.workflowCards([
    ['configuration','Configuration',`/admin/servers/${id}/edit`,'Connection, capacity, placement and server credentials'],
    ['libraries','Libraries',`/admin/libraries?serverId=${id}`,'Library discovery, visibility and access state'],
    ['users','Users / Import',`/admin/servers/${id}/users`,'Assigned Jellyfin users, matching and imports']
  ],active,'Server control room');
}

module.exports={serverTabs};
