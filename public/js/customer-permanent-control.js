'use strict';

document.addEventListener('DOMContentLoaded',()=>{
  const actions=document.querySelector('.customerControlCentre .controlCentreActions');
  const match=window.location.pathname.match(/^\/admin\/users\/([^/]+)$/);
  if(!actions||!match)return;
  const link=document.createElement('a');
  link.className='button secondary';
  link.href=`/admin/users/${encodeURIComponent(match[1])}/permanent`;
  link.textContent='Permanent access';
  link.title='Keep this customer on their most recent primary plan beyond normal expiry';
  actions.appendChild(link);
});
