'use strict';

(() => {
  const hrefByKey={customers:'/admin/users',orders:'/admin/commerce/orders',tickets:'/admin/tickets'};
  const labelByKey={customers:['Customers','New customers since you last reviewed Customers'],orders:['Orders','New paid orders since you last reviewed Orders'],tickets:['Tickets','New tickets or customer replies since you last reviewed Tickets']};
  const operationalLabels={attention:['Needs Attention','Open operational issues','/admin/attention'],servers:['Servers','Offline or degraded fleet signals','/admin/servers'],payments:['Payments','Recent payment incidents','/admin/payments']};
  const normalizedPath=location.pathname.replace(/\/+$/,'')||'/';
  function businessAreaForPath(path){if(path==='/admin/users'||path==='/admin/users/dashboard'||/^\/admin\/users\/[0-9a-f-]{36}$/i.test(path))return'customers';if(path==='/admin/commerce/orders'||path==='/admin/orders')return'orders';if(path==='/admin/tickets')return'tickets';return null;}
  const areaForCurrentPage=businessAreaForPath(normalizedPath);let latestSnapshot=null;

  function currentOnlyTabs(){
    const nav=document.createElement('nav');nav.className='workflowCardGrid coherenceSectionTabs';nav.setAttribute('aria-label','Current section');
    const a=document.createElement('a');a.className='workflowCard coherenceSectionTab active';a.href=location.pathname+location.search;a.setAttribute('aria-current','page');
    const eyebrow=document.createElement('span');eyebrow.className='workflowCardEyebrow';eyebrow.textContent='Current';
    const strong=document.createElement('strong');strong.textContent=document.querySelector('.topBreadcrumb strong')?.textContent?.trim()||document.querySelector('#adminPageTitle')?.textContent?.trim()||'Current';
    a.append(eyebrow,strong);nav.appendChild(a);return nav;
  }
  function relocatePageActions(){
    const topActions=document.querySelector('.topBarActions');if(!topActions)return;
    const movable=[...topActions.children].filter(node=>!node.matches('.topStatusWrap,.topHelpLink,[data-operator-header-metrics]'));
    if(!movable.length)return;
    let tabs=document.querySelector('.coherenceSectionTabs');
    if(!tabs){tabs=currentOnlyTabs();const header=document.querySelector('.pageHeader');if(header?.parentNode)header.insertAdjacentElement('afterend',tabs);else return;}
    let row=tabs.closest('.coherenceSectionTabRow');
    if(!row){row=document.createElement('div');row.className='coherenceSectionTabRow';tabs.parentNode.insertBefore(row,tabs);row.appendChild(tabs);}
    let actions=row.querySelector('.coherenceSectionActions');if(!actions){actions=document.createElement('div');actions.className='coherenceSectionActions';actions.setAttribute('aria-label','Page actions');row.appendChild(actions);}
    movable.forEach(node=>actions.appendChild(node));
  }
  relocatePageActions();

  function clearSidebarBadge(key){const href=hrefByKey[key];if(!href)return;const link=[...document.querySelectorAll('.adminTab')].find(a=>(a.getAttribute('href')||'').split('?')[0]===href);link?.querySelector('.unreadBadge')?.remove();}
  function addSidebarBadge(key,count){const href=hrefByKey[key];if(!href||count<=0||key===areaForCurrentPage)return;const link=[...document.querySelectorAll('.adminTab')].find(a=>(a.getAttribute('href')||'').split('?')[0]===href);if(!link)return;const existing=link.querySelector('.unreadBadge');if(existing){existing.textContent=count>99?'99+':String(count);existing.setAttribute('aria-label',`${count} unread`);return;}const badge=document.createElement('span');badge.className='unreadBadge';badge.textContent=count>99?'99+':String(count);badge.setAttribute('aria-label',`${count} unread`);link.appendChild(badge);}

  function ensureMetricNodes(){const topActions=document.querySelector('.topBarActions'),status=document.querySelector('.topStatusWrap');if(!topActions||!status)return null;let group=topActions.querySelector('[data-operator-header-metrics]');if(!group){group=document.createElement('div');group.className='topHeaderMetrics';group.setAttribute('data-operator-header-metrics','');group.setAttribute('aria-label','Live business metrics');group.innerHTML='<span class="topHeaderMetric" title="Live Jellyfin streams / configured sellable stream capacity"><span>Streams</span><strong data-operator-streams>— / —</strong></span><span class="topHeaderMetric" title="Successful provider payments received this calendar month / calendar year to date"><span>Revenue M/Y</span><strong data-operator-revenue>— / —</strong></span>';status.insertAdjacentElement('afterend',group);}return group;}
  function formatMoney(minor,currency){const value=Number(minor);if(!Number.isFinite(value)||!currency)return'—';try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency),minimumFractionDigits:value%100?2:0,maximumFractionDigits:2}).format(value/100);}catch(_){return `${String(currency)} ${(value/100).toFixed(2)}`;}}
  function applyMetrics(metrics){const group=ensureMetricNodes();if(!group)return;const streams=group.querySelector('[data-operator-streams]'),revenue=group.querySelector('[data-operator-revenue]');const active=Number(metrics?.streams?.active),total=Number(metrics?.streams?.total);if(streams)streams.textContent=Number.isFinite(active)&&Number.isFinite(total)?`${active} / ${total}`:'— / —';if(revenue){const monthly=formatMoney(metrics?.monthlyRevenue?.minor,metrics?.monthlyRevenue?.currency),yearly=formatMoney(metrics?.yearlyRevenue?.minor,metrics?.yearlyRevenue?.currency);revenue.textContent=`${monthly} / ${yearly}`;}}

  function apply(data){
    if(!data?.counts)return;latestSnapshot=data;applyMetrics(data.metrics);
    Object.keys(hrefByKey).forEach(key=>{const count=Number(data.counts[key]||0);if(count<=0||key===areaForCurrentPage)clearSidebarBadge(key);else addSidebarBadge(key,count);});
    const operationalRows=Object.entries(operationalLabels).map(([key,[label,meta,href]])=>({key,label,meta,href,count:Number(data.counts[key]||0),business:false})).filter(row=>row.count>0);
    const businessRows=Object.entries(labelByKey).map(([key,[label,meta]])=>({key,label,meta,href:hrefByKey[key],count:Number(data.counts[key]||0),business:true})).filter(row=>row.count>0&&row.key!==areaForCurrentPage);
    const rows=[...operationalRows,...businessRows],total=rows.reduce((sum,row)=>sum+row.count,0),top=document.querySelector('[data-operator-alerts]');
    if(top){const count=top.querySelector('[data-operator-alert-count]');top.classList.toggle('warn',total>0);top.classList.toggle('clear',total<=0);top.setAttribute('aria-label',total>0?`${total} operator item${total===1?'':'s'} need review`:'System status clear');top.title=total>0?`${total} operator item${total===1?'':'s'} need review`:'System status clear';if(count)count.textContent=total>0?(total>99?'99+':String(total)):'Clear';}
    const menu=document.querySelector('[data-operator-alert-list]');if(menu){menu.innerHTML=rows.length?rows.map(row=>`<a class="topStatusItem" href="${row.href}"${row.business?` data-business-read="${row.key}"`:''}><span><strong>${row.label}</strong><br>${row.meta}</span><em>${row.count>99?'99+':row.count}</em></a>`).join(''):'<div class="topStatusEmpty">No visible alerts right now.</div>';menu.querySelectorAll('[data-business-read]').forEach(link=>link.addEventListener('click',()=>{const area=link.getAttribute('data-business-read');if(area&&latestSnapshot?.csrfToken)markAreaRead(area,latestSnapshot).catch(()=>{});}));}
  }

  function fetchSnapshot(){return fetch('/admin/api/operator-state/unread',{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'}).then(response=>response.ok?response.json():null);}
  function markAreaRead(area,data){if(!area||!data?.csrfToken)return Promise.reject(new Error('Read acknowledgement token unavailable'));const body=new URLSearchParams({area,_csrf:data.csrfToken});return fetch('/admin/api/operator-state/read',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-CSRF-Token':data.csrfToken,Accept:'application/json'},body:body.toString(),keepalive:true}).then(response=>{if(!response.ok)throw new Error(`Read acknowledgement failed (${response.status})`);return response.json();});}
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  async function markAreaReadWithRetry(area,seed){let data=seed,lastError=null;const delays=[0,200,500,1000,2000,4000];for(let attempt=0;attempt<delays.length;attempt+=1){if(delays[attempt])await wait(delays[attempt]);try{await markAreaRead(area,data);return await fetchSnapshot();}catch(error){lastError=error;if(attempt<delays.length-1)data=await fetchSnapshot().catch(()=>null)||data;}}throw lastError||new Error('Read acknowledgement failed');}
  async function refresh(){const data=await fetchSnapshot().catch(()=>null);if(data)apply(data);return data;}
  setTimeout(()=>refresh().then(data=>{if(!data||!areaForCurrentPage)return;return markAreaReadWithRetry(areaForCurrentPage,data).then(fresh=>apply(fresh||data)).catch(()=>{});}).catch(()=>{}),80);
  setInterval(()=>refresh().catch(()=>{}),15000);
})();