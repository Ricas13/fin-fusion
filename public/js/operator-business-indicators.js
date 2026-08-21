'use strict';

(() => {
  const hrefByKey={customers:'/admin/users',orders:'/admin/orders',tickets:'/admin/tickets'};
  const labelByKey={
    customers:['Customers','New customers since you last reviewed Customers'],
    orders:['Orders','New paid orders since you last reviewed Orders'],
    tickets:['Tickets','New tickets or customer replies since you last reviewed Tickets']
  };
  const operationalLabels={
    attention:['Needs Attention','Open operational issues','/admin/attention'],
    servers:['Servers','Offline or degraded fleet signals','/admin/servers'],
    payments:['Payments','Recent payment incidents','/admin/payments']
  };
  const normalizedPath=location.pathname.replace(/\/+$/,'')||'/';
  function businessAreaForPath(path){
    if(path==='/admin/users'||path==='/admin/users/dashboard')return'customers';
    if(path==='/admin/orders')return'orders';
    if(path==='/admin/tickets')return'tickets';
    return null;
  }
  const areaForCurrentPage=businessAreaForPath(normalizedPath);

  function addSidebarBadge(key,count){
    const href=hrefByKey[key];
    if(!href||count<=0||key===areaForCurrentPage)return;
    const link=[...document.querySelectorAll('.adminTab')].find(a=>(a.getAttribute('href')||'').split('?')[0]===href);
    if(!link||link.querySelector('.unreadBadge'))return;
    const badge=document.createElement('span');
    badge.className='unreadBadge';
    badge.textContent=count>99?'99+':String(count);
    badge.setAttribute('aria-label',`${count} unread`);
    link.appendChild(badge);
  }

  function apply(data){
    if(!data?.counts)return;
    if(areaForCurrentPage)data.counts[areaForCurrentPage]=0;
    Object.keys(hrefByKey).forEach(key=>addSidebarBadge(key,Number(data.counts[key]||0)));
    const operationalRows=Object.entries(operationalLabels)
      .map(([key,[label,meta,href]])=>({key,label,meta,href,count:Number(data.counts[key]||0)}))
      .filter(row=>row.count>0);
    const businessRows=Object.entries(labelByKey)
      .map(([key,[label,meta]])=>({key,label,meta,href:hrefByKey[key],count:Number(data.counts[key]||0)}))
      .filter(row=>row.count>0);
    const rows=[...operationalRows,...businessRows];
    const total=rows.reduce((sum,row)=>sum+row.count,0);
    const top=document.querySelector('[data-operator-alerts]');
    if(top){
      const count=top.querySelector('[data-operator-alert-count]');
      top.classList.toggle('warn',total>0);
      top.classList.toggle('clear',total<=0);
      top.setAttribute('aria-label',total>0?`${total} operator item${total===1?'':'s'} need review`:'System status clear');
      top.title=total>0?`${total} operator item${total===1?'':'s'} need review`:'System status clear';
      if(count)count.textContent=total>0?(total>99?'99+':String(total)):'Clear';
    }
    const menu=document.querySelector('[data-operator-alert-list]');
    if(menu)menu.innerHTML=rows.length?rows.map(row=>`<a class="topStatusItem" href="${row.href}"><span><strong>${row.label}</strong><br>${row.meta}</span><em>${row.count>99?'99+':row.count}</em></a>`).join(''):'<div class="topStatusEmpty">No visible alerts right now.</div>';
  }

  function markCurrentAreaRead(data){
    if(!areaForCurrentPage||!data?.csrfToken)return Promise.resolve();
    const body=new URLSearchParams({area:areaForCurrentPage});
    return fetch('/admin/api/operator-state/read',{
      method:'POST',
      credentials:'same-origin',
      headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-CSRF-Token':data.csrfToken,Accept:'application/json'},
      body:body.toString(),
      keepalive:true
    }).then(()=>{}).catch(()=>{});
  }

  setTimeout(()=>fetch('/admin/api/operator-state/unread',{headers:{Accept:'application/json'},credentials:'same-origin'})
    .then(r=>r.ok?r.json():null)
    .then(data=>{if(!data)return;return markCurrentAreaRead(data).then(()=>apply(data));})
    .catch(()=>{}),80);
})();
