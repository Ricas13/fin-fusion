'use strict';

(() => {
  const hrefByKey={customers:'/admin/users',orders:'/admin/commerce/orders',tickets:'/admin/tickets'};
  const labelByKey={customers:['Customers','New customers since you last reviewed Customers'],orders:['Orders','New paid orders since you last reviewed Orders'],tickets:['Tickets','New tickets or customer replies since you last reviewed Tickets']};
  const normalizedPath=location.pathname.replace(/\/+$/,'')||'/';
  function businessAreaForPath(path){if(path==='/admin/users'||path==='/admin/users/dashboard'||/^\/admin\/users\/[0-9a-f-]{36}$/i.test(path))return'customers';if(path==='/admin/commerce/orders'||path==='/admin/orders')return'orders';if(path==='/admin/tickets')return'tickets';return null;}
  const areaForCurrentPage=businessAreaForPath(normalizedPath);let latestSnapshot=null;

  function ensureStyles(){if(document.querySelector('link[href="/css/operator-business-indicators.css"]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href='/css/operator-business-indicators.css';document.head.appendChild(link);}
  ensureStyles();

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

  function ensureMetricNodes(){const topActions=document.querySelector('.topBarActions'),status=document.querySelector('.topStatusWrap');if(!topActions||!status)return null;let group=topActions.querySelector('[data-operator-header-metrics]');if(!group){group=document.createElement('div');group.className='topHeaderMetrics';group.setAttribute('data-operator-header-metrics','');group.setAttribute('aria-label','Live business metrics');group.innerHTML='<span class="topHeaderMetric" title="Live Jellyfin streams / configured sellable stream capacity"><span>Streams</span><strong data-operator-streams>—/—</strong></span><a class="topHeaderMetric" href="/admin/expenses" title="Net provider receipts (imported history + webhooks) minus booked expenses. Bank payouts are transfers, not costs."><span>Profit</span><strong data-operator-profit>— · —</strong></a>';status.insertAdjacentElement('afterend',group);}return group;}
  function formatMoney(minor,currency){const value=Number(minor);if(!Number.isFinite(value)||!currency)return'—';try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency),currencyDisplay:'narrowSymbol',minimumFractionDigits:value%100?2:0,maximumFractionDigits:2}).format(value/100);}catch(_){return `${({'GBP':'£','USD':'$','EUR':'€'})[String(currency).toUpperCase()]||'¤'}${(value/100).toFixed(2)}`;}}
  function applyMetrics(metrics){const group=ensureMetricNodes();if(!group)return;const streams=group.querySelector('[data-operator-streams]'),profit=group.querySelector('[data-operator-profit]');const active=Number(metrics?.streams?.active),total=Number(metrics?.streams?.total);if(streams)streams.textContent=Number.isFinite(active)&&Number.isFinite(total)?`${active}/${total}`:'—/—';if(profit){const month=formatMoney(metrics?.monthlyProfit?.minor,metrics?.monthlyProfit?.currency),year=formatMoney(metrics?.yearlyProfit?.minor,metrics?.yearlyProfit?.currency);profit.textContent=`${month} · ${year}`;const owner=profit.closest('.topHeaderMetric');if(owner){const monthBasis=String(metrics?.monthlyProfit?.basisText||'').trim(),yearBasis=String(metrics?.yearlyProfit?.basisText||'').trim();owner.title=`Month: ${monthBasis} YTD: ${yearBasis}`.trim();}}}

  function signalMenuMarkup({key,tone,label,primaryHref,items}){
    return `<div class="operatorSignal operatorSignal--${tone}" data-operator-signal="${key}" hidden><button class="operatorSignalSummary${tone==='alert'?' warn':''}" type="button" aria-expanded="false"><span>${label}</span><strong data-operator-signal-count>0</strong></button><div class="operatorSignalMenu operatorSignalMenu--${tone}" hidden><div class="operatorSignalMenuHead"><strong>${label}</strong><a href="${primaryHref}">View all</a></div><div class="operatorSignalMenuBody">${items.map(item=>`<a class="operatorSignalRow operatorSignalRow--${tone}" href="${item.href}" data-signal-source="${item.key}"${item.business?` data-business-read="${item.key}"`:''}><span><strong>${item.label}</strong><small>${item.meta}</small></span><em data-signal-count="${item.key}">0</em></a>`).join('')}</div></div></div>`;
  }
  function ensureSignalNodes(){
    const wrap=document.querySelector('.topStatusWrap');if(!wrap)return null;
    if(wrap.dataset.operatorSignalsReady==='1')return wrap;
    wrap.dataset.operatorSignalsReady='1';wrap.classList.add('operatorSignalStrip');
    wrap.innerHTML=`<a class="operatorSignal operatorSignal--new operatorSignalSummary" data-operator-signal="new" href="/admin/users" data-business-read="customers" hidden><span>New</span><strong data-operator-signal-count>0</strong></a>${signalMenuMarkup({key:'alerts',tone:'alert',label:'Alerts',primaryHref:'/admin/attention',items:[{key:'attention',label:'Attention',meta:'Open operational issues',href:'/admin/attention'},{key:'servers',label:'Servers',meta:'Offline or degraded fleet signals',href:'/admin/servers'},{key:'payments',label:'Payments',meta:'Unprocessed or failed payment events',href:'/admin/payments'}]})}${signalMenuMarkup({key:'inbox',tone:'inbox',label:'Inbox',primaryHref:'/admin/tickets',items:[{key:'tickets',label:'Tickets',meta:'New tickets or customer replies',href:'/admin/tickets',business:true},{key:'orders',label:'Orders',meta:'New paid orders',href:'/admin/commerce/orders',business:true}]})}`;
    wrap.querySelectorAll('button.operatorSignalSummary').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const owner=button.closest('.operatorSignal');const menu=owner?.querySelector('.operatorSignalMenu');if(!menu)return;const open=menu.hidden;wrap.querySelectorAll('.operatorSignalMenu').forEach(other=>{other.hidden=true;other.closest('.operatorSignal')?.querySelector('button')?.setAttribute('aria-expanded','false');});menu.hidden=!open;button.setAttribute('aria-expanded',open?'true':'false');}));
    document.addEventListener('click',event=>{if(wrap.contains(event.target))return;wrap.querySelectorAll('.operatorSignalMenu').forEach(menu=>{menu.hidden=true;menu.closest('.operatorSignal')?.querySelector('button')?.setAttribute('aria-expanded','false');});});
    wrap.querySelectorAll('[data-business-read]').forEach(link=>link.addEventListener('click',()=>{const area=link.getAttribute('data-business-read');if(area&&latestSnapshot?.csrfToken)markAreaRead(area,latestSnapshot).catch(()=>{});}));
    return wrap;
  }
  function setSignal(key,total,sourceCounts={}){
    const wrap=ensureSignalNodes(),node=wrap?.querySelector(`[data-operator-signal="${key}"]`);if(!node)return;
    const count=Math.max(0,Number(total||0));node.hidden=count<=0;const badge=node.querySelector('[data-operator-signal-count]');if(badge)badge.textContent=count>99?'99+':String(count);
    Object.entries(sourceCounts).forEach(([source,value])=>{const row=node.querySelector(`[data-signal-source="${source}"]`),rowCount=node.querySelector(`[data-signal-count="${source}"]`),n=Math.max(0,Number(value||0));if(row)row.hidden=n<=0;if(rowCount)rowCount.textContent=n>99?'99+':String(n);});
  }

  function apply(data){
    if(!data?.counts)return;latestSnapshot=data;applyMetrics(data.metrics);
    Object.keys(hrefByKey).forEach(key=>{const count=Number(data.counts[key]||0);if(count<=0||key===areaForCurrentPage)clearSidebarBadge(key);else addSidebarBadge(key,count);});
    const customers=Number(data.counts.customers||0),attention=Number(data.counts.attention||0),servers=Number(data.counts.servers||0),payments=Number(data.counts.payments||0),tickets=Number(data.counts.tickets||0),orders=Number(data.counts.orders||0);
    setSignal('new',areaForCurrentPage==='customers'?0:customers);
    setSignal('alerts',attention+servers+payments,{attention,servers,payments});
    setSignal('inbox',(areaForCurrentPage==='tickets'?0:tickets)+(areaForCurrentPage==='orders'?0:orders),{tickets:areaForCurrentPage==='tickets'?0:tickets,orders:areaForCurrentPage==='orders'?0:orders});
  }

  function fetchSnapshot(){return fetch('/admin/api/operator-state/unread',{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'}).then(response=>response.ok?response.json():null);}
  function markAreaRead(area,data){if(!area||!data?.csrfToken)return Promise.reject(new Error('Read acknowledgement token unavailable'));const body=new URLSearchParams({area,_csrf:data.csrfToken});return fetch('/admin/api/operator-state/read',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-CSRF-Token':data.csrfToken,Accept:'application/json'},body:body.toString(),keepalive:true}).then(response=>{if(!response.ok)throw new Error(`Read acknowledgement failed (${response.status})`);return response.json();});}
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  async function markAreaReadWithRetry(area,seed){let data=seed,lastError=null;const delays=[0,200,500,1000,2000,4000];for(let attempt=0;attempt<delays.length;attempt+=1){if(delays[attempt])await wait(delays[attempt]);try{await markAreaRead(area,data);return await fetchSnapshot();}catch(error){lastError=error;if(attempt<delays.length-1)data=await fetchSnapshot().catch(()=>null)||data;}}throw lastError||new Error('Read acknowledgement failed');}
  async function refresh(){const data=await fetchSnapshot().catch(()=>null);if(data)apply(data);return data;}
  ensureSignalNodes();
  setTimeout(()=>refresh().then(data=>{if(!data||!areaForCurrentPage)return;return markAreaReadWithRetry(areaForCurrentPage,data).then(fresh=>apply(fresh||data)).catch(()=>{});}).catch(()=>{}),80);
  setInterval(()=>refresh().catch(()=>{}),15000);
})();