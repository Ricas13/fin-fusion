'use strict';

(() => {
  const hrefByKey={customers:'/admin/users',orders:'/admin/commerce/orders',tickets:'/admin/tickets'};
  const labelByKey={customers:['Customers','New customers since you last reviewed Customers'],orders:['Orders','New paid orders since you last reviewed Orders'],tickets:['Tickets','New tickets or customer replies since you last reviewed Tickets']};
  const normalizedPath=location.pathname.replace(/\/+$/,'')||'/';
  function businessAreaForPath(path){if(path==='/admin/users'||path==='/admin/users/dashboard'||/^\/admin\/users\/[0-9a-f-]{36}$/i.test(path))return'customers';if(path==='/admin/commerce/orders'||path==='/admin/orders')return'orders';if(path==='/admin/tickets')return'tickets';if(path==='/admin/payments')return'payments';return null;}
  const areaForCurrentPage=businessAreaForPath(normalizedPath);

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

  function signalMenuMarkup({key,tone,label,headLabel=label,primaryHref,primaryLabel='View all',items}){
    const persistent=tone==='alert';
    const summaryTitle=persistent?'Operational alerts. Attention and server health persist until resolved; provider callback notifications clear after you review Payments.':'';
    const headStatus=persistent?'<small>Health persists · provider callbacks clear after review</small>':'';
    return `<div class="operatorSignal operatorSignal--${tone}${persistent?' operatorSignal--persistent':''}" data-operator-signal="${key}" hidden><button class="operatorSignalSummary" type="button" aria-expanded="false"${summaryTitle?` title="${summaryTitle}"`:''}><span>${label}</span><strong data-operator-signal-count>0</strong></button><div class="operatorSignalMenu operatorSignalMenu--${tone}" hidden><div class="operatorSignalMenuHead"><span><strong>${headLabel}</strong>${headStatus}</span><a href="${primaryHref}">${primaryLabel}</a></div><div class="operatorSignalMenuBody">${items.map(item=>`<a class="operatorSignalRow operatorSignalRow--${tone}" href="${item.href}" data-signal-source="${item.key}"><span><strong>${item.label}</strong><small>${item.meta}</small></span><em data-signal-count="${item.key}">0</em></a>`).join('')}</div></div></div>`;
  }
  function ensureSignalNodes(){
    const wrap=document.querySelector('.topStatusWrap');if(!wrap)return null;
    if(wrap.dataset.operatorSignalsReady==='1')return wrap;
    wrap.dataset.operatorSignalsReady='1';wrap.classList.add('operatorSignalStrip');
    wrap.innerHTML=`<a class="operatorSignal operatorSignal--new operatorSignalSummary" data-operator-signal="new" href="/admin/users" hidden><span>New</span><strong data-operator-signal-count>0</strong></a>${signalMenuMarkup({key:'alerts',tone:'alert',label:'Alerts',headLabel:'Operational alerts',primaryHref:'/admin/attention',primaryLabel:'Review attention',items:[{key:'attention',label:'Attention',meta:'Unacknowledged items — acknowledge after review',href:'/admin/attention'},{key:'servers',label:'Servers',meta:'Unresolved health state — clears when recovered',href:'/admin/servers'},{key:'payments',label:'Payments',meta:'New provider callback issues — clears after review',href:'/admin/payments'}]})}${signalMenuMarkup({key:'inbox',tone:'inbox',label:'Inbox',primaryHref:'/admin/tickets',items:[{key:'tickets',label:'Tickets',meta:'New tickets or customer replies',href:'/admin/tickets'},{key:'orders',label:'Orders',meta:'New paid orders',href:'/admin/commerce/orders'}]})}`;
    wrap.querySelectorAll('button.operatorSignalSummary').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const owner=button.closest('.operatorSignal');const menu=owner?.querySelector('.operatorSignalMenu');if(!menu)return;const open=menu.hidden;wrap.querySelectorAll('.operatorSignalMenu').forEach(other=>{other.hidden=true;other.closest('.operatorSignal')?.querySelector('button')?.setAttribute('aria-expanded','false');});menu.hidden=!open;button.setAttribute('aria-expanded',open?'true':'false');}));
    document.addEventListener('click',event=>{if(wrap.contains(event.target))return;wrap.querySelectorAll('.operatorSignalMenu').forEach(menu=>{menu.hidden=true;menu.closest('.operatorSignal')?.querySelector('button')?.setAttribute('aria-expanded','false');});});
    return wrap;
  }
  function setSignal(key,total,sourceCounts={}){
    const wrap=ensureSignalNodes(),node=wrap?.querySelector(`[data-operator-signal="${key}"]`);if(!node)return;
    const count=Math.max(0,Number(total||0));node.hidden=count<=0;const badge=node.querySelector('[data-operator-signal-count]');if(badge){badge.textContent=key==='alerts'?'!':count>99?'99+':String(count);if(key==='alerts')badge.setAttribute('aria-label',`${count} operational alert signals`);}
    if(key==='alerts'){const summary=node.querySelector('.operatorSignalSummary');if(summary)summary.setAttribute('aria-label','Alerts: attention and server health persist until resolved; payment callback notifications clear after review.');}
    Object.entries(sourceCounts).forEach(([source,value])=>{const row=node.querySelector(`[data-signal-source="${source}"]`),rowCount=node.querySelector(`[data-signal-count="${source}"]`),n=Math.max(0,Number(value||0));if(row)row.hidden=n<=0;if(rowCount){rowCount.textContent=n>99?'99+':String(n);if(key==='alerts')rowCount.setAttribute('title',source==='payments'?`${n} new since review`:`${n} unresolved`);}});
  }

  function apply(data){
    if(!data?.counts)return;applyMetrics(data.metrics);
    Object.keys(hrefByKey).forEach(key=>{const count=Number(data.counts[key]||0);if(count<=0||key===areaForCurrentPage)clearSidebarBadge(key);else addSidebarBadge(key,count);});
    const customers=Number(data.counts.customers||0),attention=Number(data.counts.attention||0),servers=Number(data.counts.servers||0),payments=areaForCurrentPage==='payments'?0:Number(data.counts.payments||0),tickets=Number(data.counts.tickets||0),orders=Number(data.counts.orders||0);
    setSignal('new',areaForCurrentPage==='customers'?0:customers);
    setSignal('alerts',attention+servers+payments,{attention,servers,payments});
    setSignal('inbox',(areaForCurrentPage==='tickets'?0:tickets)+(areaForCurrentPage==='orders'?0:orders),{tickets:areaForCurrentPage==='tickets'?0:tickets,orders:areaForCurrentPage==='orders'?0:orders});
  }

  function fetchSnapshot(){return fetch('/admin/api/operator-state/unread',{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'}).then(response=>response.ok?response.json():null);}
  function seenThroughFor(area,data){const value=Number(data?.updatedAt?.[area]||0);return Number.isFinite(value)&&value>0?String(Math.trunc(value)):null;}
  function markAreaRead(area,data){const seenThrough=seenThroughFor(area,data);if(!area||!seenThrough||!data?.csrfToken)return Promise.reject(new Error('Read acknowledgement data unavailable'));const body=new URLSearchParams({area,seenThrough,_csrf:data.csrfToken});return fetch('/admin/api/operator-state/read',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-CSRF-Token':data.csrfToken,Accept:'application/json'},body:body.toString(),keepalive:true}).then(response=>{if(!response.ok)throw new Error(`Read acknowledgement failed (${response.status})`);return response.json();});}
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  async function markAreaReadWithRetry(area,data){let lastError=null;for(const delay of [0,250,750,1500]){if(delay)await wait(delay);try{return await markAreaRead(area,data);}catch(error){lastError=error;}}throw lastError||new Error('Read acknowledgement failed');}
  function locallyClearedSnapshot(data,area){return {...data,counts:{...data.counts,[area]:0}};}
  async function acknowledgeCurrentArea(data){if(!areaForCurrentPage||Number(data?.counts?.[areaForCurrentPage]||0)<=0||!seenThroughFor(areaForCurrentPage,data))return data;try{await markAreaReadWithRetry(areaForCurrentPage,data);const cleared=locallyClearedSnapshot(data,areaForCurrentPage);apply(cleared);const fresh=await fetchSnapshot().catch(()=>null);if(fresh)apply(fresh);return fresh||cleared;}catch(_){return data;}}
  async function refresh(){const data=await fetchSnapshot().catch(()=>null);if(!data)return null;apply(data);return acknowledgeCurrentArea(data);}
  ensureSignalNodes();
  setTimeout(()=>refresh().catch(()=>{}),80);
  setInterval(()=>refresh().catch(()=>{}),15000);
})();