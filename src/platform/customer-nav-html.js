'use strict';

const {esc}=require('./admin-html');
const ITEMS=[
  ['overview','Home','/account'],
  ['streaming','Setup','/account#streaming'],
  ['plans','Plan & billing','/account#plans'],
  ['activity','Activity','/account/activity'],
  ['support','Support','/account/support'],
  ['account','Account','/account/security']
];
function nav(active='',options={}){
  const rows=[...ITEMS];
  if(options.showBenefits)rows.push(['benefits','Benefits','/account/affiliate']);
  if(options.showHelp)rows.push(['help','Help','/help']);
  const activeKey=(active==='notifications'||active==='security')?'account':active;
  return `<nav class="customerPortalNav" aria-label="Customer navigation">${rows.map(([key,label,url])=>`<a class="customerPortalNavLink ${activeKey===key?'active':''}" href="${esc(url)}">${esc(label)}</a>`).join('')}</nav>`;
}
module.exports={ITEMS,nav};
