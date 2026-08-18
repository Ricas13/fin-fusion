'use strict';

const {esc}=require('./admin-html');
const ITEMS=[
  ['overview','Overview','/account'],
  ['streaming','Streaming','/account#streaming'],
  ['plans','Plans & billing','/account#plans'],
  ['activity','Activity','/account/activity'],
  ['notifications','Notifications','/account/communications'],
  ['security','Security','/account/security'],
  ['benefits','Benefits','/account/affiliate'],
  ['help','Help & support','/help']
];
function nav(active=''){return `<nav class="customerPortalNav" aria-label="Customer navigation">${ITEMS.map(([key,label,url])=>`<a class="customerPortalNavLink ${active===key?'active':''}" href="${esc(url)}">${esc(label)}</a>`).join('')}</nav>`;}
module.exports={ITEMS,nav};
