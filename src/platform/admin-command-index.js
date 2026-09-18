'use strict';

const nav=require('./admin-nav');
const settings=require('./settings-registry');

const EXTRA=Object.freeze([
  Object.freeze({label:'Add customer',href:'/admin/users/new',group:'Customers',keywords:'new create invite customer'}),
  Object.freeze({label:'Add Jellyfin server',href:'/admin/servers/new',group:'Servers',keywords:'new create jellyfin server'})
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
function attr(value){
  return String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}
function markup(){
  return all().map(item=>`<i hidden data-admin-command-seed data-label="${attr(item.label)}" data-href="${attr(item.href)}" data-group="${attr(item.group)}" data-keywords="${attr(item.keywords)}"></i>`).join('');
}

module.exports={all,markup,EXTRA};
