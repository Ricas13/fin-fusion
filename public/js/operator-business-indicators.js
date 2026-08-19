'use strict';

(() => {
  const hrefByKey={customers:'/admin/users',orders:'/admin/orders',tickets:'/admin/tickets'};
  const labelByKey={
    customers:['Customers','New customers in the last 7 days'],
    orders:['Orders','New paid orders in the last 7 days'],
    tickets:['Tickets','Tickets waiting for staff']
  };
  const allLabels={
    attention:['Needs Attention','Open operational issues','/admin/attention'],
    servers:['Servers','Offline or degraded fleet signals','/admin/servers'],
    payments:['Payments','Recent payment incidents','/admin/payments'],
    ...Object.fromEntries(Object.entries(labelByKey).map(([key,[label,meta]])=>[key,[label,meta,hrefByKey[key]]]))
  };
  function seen(href){try{return Number(localStorage.getItem(`captainfin.operator.seen.${href}`)||0)}catch{return 0}}
  function addSidebarBadge(key,count,updatedAt){const href=hrefByKey[key];if(!href||count<=0||!updatedAt||seen(href)>=updatedAt)return;const link=[...document.querySelectorAll('.adminTab')].find(a=>(a.getAttribute('href')||'').split('?')[0]===href);if(!link||link.querySelector('.unreadBadge'))return;const badge=document.createElement('span');badge.className='unreadBadge';badge.textContent=count>99?'99+':String(count);badge.setAttribute('aria-label',`${count} unread`);link.appendChild(badge);}
  function apply(data){
    if(!data?.counts)return;
    Object.keys(hrefByKey).forEach(key=>addSidebarBadge(key,Number(data.counts[key]||0),Number(data.updatedAt?.[key]||0)));
    const total=Object.keys(allLabels).reduce((sum,key)=>sum+Number(data.counts[key]||0),0);
    const top=document.querySelector('[data-operator-alerts]');
    if(top){const count=top.querySelector('[data-operator-alert-count]');top.classList.toggle('warn',total>0);top.classList.toggle('clear',total<=0);top.setAttribute('aria-label',total>0?`${total} operator item${total===1?'':'s'} need review`:'System status clear');top.title=total>0?`${total} operator item${total===1?'':'s'} need review`:'System status clear';if(count)count.textContent=total>0?(total>99?'99+':String(total)):'Clear';}
    const menu=document.querySelector('[data-operator-alert-list]');
    if(menu){const rows=Object.entries(allLabels).map(([key,[label,meta,href]])=>({key,label,meta,href,count:Number(data.counts[key]||0)})).filter(row=>row.count>0);menu.innerHTML=rows.length?rows.map(row=>`<a class="topStatusItem" href="${row.href}"><span><strong>${row.label}</strong><br>${row.meta}</span><em>${row.count>99?'99+':row.count}</em></a>`).join(''):'<div class="topStatusEmpty">No visible alerts right now.</div>';}
  }
  setTimeout(()=>fetch('/admin/api/operator-state/unread',{headers:{Accept:'application/json'},credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(apply).catch(()=>{}),80);
})();
