'use strict';

const nav=require('./admin-nav');
const settings=require('./settings-registry');

const EXTRA=Object.freeze([
  Object.freeze({label:'Add customer',href:'/admin/users/new',group:'Customers',keywords:'new create invite customer'}),
  Object.freeze({label:'Import Jellyfin users',href:'/admin/jellyfin-import',group:'Customers',keywords:'import existing jellyfin accounts users'}),
  Object.freeze({label:'Add Jellyfin server',href:'/admin/servers/new',group:'Servers',keywords:'new create jellyfin server'}),
  Object.freeze({label:'Needs Attention',href:'/admin/attention',group:'Dashboard',keywords:'alerts problems issues review intervention'}),
  Object.freeze({label:'Global record search',href:'/admin/search',group:'Dashboard',keywords:'customer plan server billing provider reference id'})
]);

function groupLabel(groupKey){
  return nav.groups.find(group=>group.key===groupKey)?.label||'Administration';
}
function parentLabel(item){
  const group=nav.groups.find(candidate=>candidate.key===item.groupKey);
  return group?.pages.find(page=>page[0]===item.parentKey)?.[1]||groupLabel(item.groupKey);
}
function all(){
  const rows=[];
  const add=(entry)=>{if(!entry?.label||!entry?.href)return;rows.push({
    label:String(entry.label),
    href:String(entry.href),
    group:String(entry.group||'Administration'),
    keywords:String(entry.keywords||'')
  });};

  for(const group of nav.groups){
    for(const page of group.pages)add({label:page[1],href:page[2],group:group.label,keywords:`${group.key} ${page[0]}`});
  }
  for(const item of Object.values(nav.hiddenPages)){
    add({
      label:item.page[1],
      href:item.page[2],
      group:`${groupLabel(item.groupKey)} · ${parentLabel(item)}`,
      keywords:`${item.kind} ${item.page[0]} ${item.parentKey} ${item.groupKey}`
    });
  }
  for(const item of settings.SETTINGS){
    const owner=settings.ownerForSetting(item.key);
    if(!owner)continue;
    add({
      label:item.label,
      href:item.href||owner.href,
      group:`Settings · ${owner.label}`,
      keywords:`${item.key} ${item.keywords||''} ${owner.scope||''} ${owner.description||''}`
    });
  }
  EXTRA.forEach(add);
  return rows;
}
function json(){
  return JSON.stringify(all()).replace(/</g,'\\u003c');
}

module.exports={all,json,EXTRA};
