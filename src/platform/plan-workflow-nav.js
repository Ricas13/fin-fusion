'use strict';

function serviceType(plan){
  const value=String(plan?.service_type||'jellyfin').toLowerCase();
  return ['jellyfin','stremio','bundle'].includes(value)?value:'jellyfin';
}
function includesJellyfin(plan){return ['jellyfin','bundle'].includes(serviceType(plan));}
function tabs(plan,active='overview'){
  if(!plan?.id)return'';
  const id=encodeURIComponent(plan.id),items=[
    ['overview','Overview',`/admin/plans/${id}/edit`],
    ['delivery','Delivery',`/admin/plans/${id}/delivery`],
    ['availability','Availability',`/admin/plans/${id}/inventory`],
    ['commerce','Commerce',`/admin/plans/${id}/commerce`]
  ];
  if(includesJellyfin(plan))items.push(['lifecycle','Lifecycle',`/admin/plans/${id}/lifecycle`]);
  return `<nav class="operatorTabs planWorkflowTabs" aria-label="Plan management">${items.map(([key,label,url])=>`<a class="operatorTab ${active===key?'active':''}" href="${url}">${label}</a>`).join('')}</nav>`;
}
function deliveryTools(plan,active='delivery'){
  if(!includesJellyfin(plan))return'';
  const id=encodeURIComponent(plan.id),items=[
    ['jellyfin','Playback policy',`/admin/plans/${id}/jellyfin`],
    ['libraries','Libraries',`/admin/plans/${id}/libraries`],
    ['placement','Server placement',`/admin/plans/${id}/placement`]
  ];
  return `<div class="buttonRow planDeliveryTools" aria-label="Jellyfin delivery settings">${items.map(([key,label,url])=>`<a class="button ${active===key?'':'secondary'} btn-sm" href="${url}">${label}</a>`).join('')}</div>`;
}
module.exports={serviceType,includesJellyfin,tabs,deliveryTools};
