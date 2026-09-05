'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  const match=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(!match)return;
  const customerId=match[1];
  const text=node=>String(node?.textContent||'').trim();

  const style=document.createElement('style');
  style.textContent=`
    .content>.pageHeader{display:none!important}
    .topBarActions>a[href="/admin/users"]{display:none!important}

    /* Approved Customer 360 proportions */
    .customerMockHero{margin:0 0 10px!important;gap:18px!important}
    .customerMockIdentity{grid-template-columns:74px minmax(0,1fr)!important;gap:18px!important}
    .customerMockAvatar{width:74px!important;height:74px!important}
    .customerMockName h2{font-size:1.24rem!important}
    .customerMockEmail{font-size:.80rem!important;margin-top:5px!important}
    .customerMockMeta{font-size:.62rem!important;margin-top:7px!important}
    .customerMockPills{margin-top:7px!important}
    .customerMockTopActions{gap:7px!important;margin-bottom:0!important}
    .mockTopButton{min-height:30px!important;padding:5px 12px!important;border-radius:7px!important;font-size:.67rem!important}
    .customerMockMetrics{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:9px!important}
    .customerMockMetric{min-height:70px!important;padding:9px 12px!important;border-radius:8px!important;background:#101a23!important}
    .customerMockMetric small{font-size:.60rem!important}
    .customerMockMetric strong{font-size:.86rem!important;margin-top:4px!important}
    .customerMockMetric span{font-size:.60rem!important;margin-top:3px!important}

    .customerPrimaryActions{margin:8px 0 9px!important;padding:10px 13px!important;border-radius:9px!important;background:#101922!important}
    .customerPrimaryHead h2{font-size:.91rem!important}
    .customerPrimaryHead p{font-size:.62rem!important;margin:2px 0 8px!important}
    .customerActionGrid{grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:8px!important}
    .actionTile{height:78px!important;border-radius:7px!important;padding:7px 6px!important;grid-template-rows:26px auto auto!important}
    .actionIcon,.actionIcon svg{width:23px!important;height:23px!important}
    .actionTile strong{font-size:.65rem!important}
    .actionTile small{font-size:.54rem!important}

    .customer360Core{gap:6px!important}
    .customer360Core .opGrid{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:10px!important;align-items:stretch!important}
    .customer360Core .opCard{min-height:238px!important;padding:11px!important;border-radius:8px!important;background:#101922!important;display:flex!important;flex-direction:column!important}
    .customer360Core .opCardHead{margin-bottom:7px!important}
    .customer360Core .opCardHead h2{font-size:.83rem!important}
    .customer360Core .opCardBody{flex:1!important;gap:3px!important}
    .customer360Core .opState{font-size:.66rem!important;padding:2px 0!important}
    .customer360Core .opItem,.customer360Core .opHold{padding:5px 0!important}
    .customer360Core .opItem strong,.customer360Core .opHold strong{font-size:.69rem!important}
    .customer360Core .opItem span,.customer360Core .opHold span{font-size:.60rem!important}
    .customer360Core .opActions{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px!important;margin-top:8px!important}
    .customer360Core .opActions>*{min-width:0}
    .customer360Core .opActions .plainForm,.customer360Core .opActions .button{width:100%!important}
    .customer360Core .opActions .button,.mockCardButton{min-height:27px!important;padding:4px 5px!important;border-radius:6px!important;font-size:.59rem!important}
    .customer360Core .opActions form[action$="/manage/reconcile"]{display:none!important}

    /* Keep screenshot actions visible; only the duplicated generic reconcile is hidden above. */
    .opMoreActions{display:none!important}

    .approvedAdvanced,.customer360Core .opDisclosure{border:1px solid var(--border,#29333d)!important;border-radius:6px!important;margin:0!important;padding:0 9px!important;background:#0f1820!important}
    .approvedAdvanced>summary,.customer360Core .opDisclosure>summary{min-height:25px!important;padding:4px 2px!important;font-size:.61rem!important}
    .approvedAdvanced>summary{grid-template-columns:auto 1fr auto!important;gap:12px!important}
    .approvedAdvanced>summary span,.customer360Core .opDisclosure>summary small{font-size:.56rem!important}
    .customer360Core .opDisclosure+.opDisclosure,.approvedAdvanced+.opDisclosure{margin-top:4px!important}

    .customerPaymentIncidentsFolded{margin-top:9px;border-top:1px solid var(--border);padding-top:8px}
    .customerPaymentIncidentsFolded>.sectionHead{margin-bottom:6px}
    .customerPaymentIncidentsFolded>.sectionHead h2{font-size:.75rem}
    .mockDangerWarning{grid-column:1/-1;border:1px solid rgba(215,154,59,.45);border-radius:6px;background:rgba(141,90,18,.14);padding:8px 9px;color:#d9ae67;font-size:.60rem;line-height:1.3}
    .mockCardButton{display:inline-flex;align-items:center;justify-content:center;border:1px solid #315a78;background:transparent;color:var(--text);cursor:pointer;text-decoration:none}
    .mockCardButton:hover{border-color:#4fb8f4}

    @media(max-width:1450px){.customerActionGrid{grid-template-columns:repeat(4,minmax(0,1fr))!important}.customer360Core .opGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
    @media(max-width:1000px){.customerMockMetrics{grid-template-columns:repeat(2,minmax(0,1fr))!important}.customerActionGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
    @media(max-width:620px){.customer360Core .opGrid,.customerActionGrid,.customerMockMetrics{grid-template-columns:1fr!important}}
  `;
  document.head.appendChild(style);

  function customerName(){return text(document.querySelector('.customerMockName [data-customer-name]'))||text(document.querySelector('.customerMockName h2'))||text(document.querySelector('.customerMockEmail'))||'Customer';}

  function alignBreadcrumb(){
    const crumb=document.querySelector('.topBreadcrumb');
    if(!crumb||crumb.dataset.customerCrumb==='1')return;
    crumb.dataset.customerCrumb='1';
    const name=customerName().replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    crumb.innerHTML=`<a href="/admin/users">Customers</a><span>/</span><a href="/admin/users">All customers</a><span>/</span><strong>${name}</strong>`;
  }

  function cleanLegacyHeader(){
    document.querySelectorAll('a,button').forEach(node=>{
      const label=text(node);
      if(label==='Change Jellyfin password'&&!node.closest('.customerMockHero')&&!node.closest('.customerPrimaryActions')&&!node.closest('.customer360Core'))node.remove();
    });
    document.querySelectorAll(`form[action="/admin/users/${customerId}/impersonate"]`).forEach(form=>{
      if(!form.closest('.customerMockHero')&&!form.closest('.customerPrimaryActions'))form.remove();
    });
  }

  function identifyCards(){
    document.querySelectorAll('.opCard').forEach(card=>{
      const title=text(card.querySelector('.opCardHead h2'));
      const ids={
        'Plans & Subscriptions':'customer-plans','Jellyfin / Emby':'customer-jellyfin','Stremio':'customer-stremio',
        'Overseerr':'customer-overseerr','Customer / Portal':'customer-portal','Discord':'customer-discord',
        'Access / Holds':'customer-holds','Danger Zone':'customer-danger'
      };
      if(ids[title])card.id=ids[title];
    });
  }

  function restoreVisibleCardActions(){
    document.querySelectorAll('details.opMoreActions').forEach(details=>{
      const actions=details.parentElement;
      const body=details.querySelector('.opMoreActionsBody');
      if(actions&&body){[...body.children].forEach(node=>actions.insertBefore(node,details));}
      details.remove();
    });
  }

  function polishPlansCard(){
    const card=document.getElementById('customer-plans');
    const actions=card?.querySelector('.opActions');
    if(!actions||actions.dataset.mockPolished==='1')return;
    actions.dataset.mockPolished='1';
    if(![...actions.querySelectorAll('button,a')].some(node=>text(node)==='Add plan manually')){
      const add=document.createElement('button');add.type='button';add.className='mockCardButton';add.textContent='Add plan manually';
      add.addEventListener('click',()=>{const grant=document.querySelector('.actionTileDetails.grant');if(grant){grant.open=true;grant.scrollIntoView({block:'center',behavior:'smooth'});}});
      actions.prepend(add);
    }
    if(![...actions.querySelectorAll('button,a')].some(node=>text(node)==='View billing history')){
      const billing=document.createElement('button');billing.type='button';billing.className='mockCardButton';billing.textContent='View billing history';
      billing.addEventListener('click',()=>{const payments=[...document.querySelectorAll('.customer360Core > .opDisclosure')].find(node=>text(node.querySelector('summary > span'))==='Payments');if(payments){payments.open=true;payments.scrollIntoView({block:'center',behavior:'smooth'});}});
      actions.appendChild(billing);
    }
  }

  function polishDangerCard(){
    const card=document.getElementById('customer-danger');
    if(!card||card.dataset.mockPolished==='1')return;
    card.dataset.mockPolished='1';
    const hint=card.querySelector('.opHint');if(hint)hint.textContent='Permanently delete this customer and all associated data.';
    card.querySelectorAll('.dangerNote').forEach(node=>node.remove());
    const actions=card.querySelector('.opActions');
    if(actions){
      const warning=document.createElement('div');warning.className='mockDangerWarning';
      warning.textContent='⚠ This cannot be undone. Billing history is retained for compliance.';
      actions.appendChild(warning);
    }
  }

  function moveAdvancedIntoBottomStack(){
    const advanced=document.querySelector('.approvedAdvanced');
    const core=document.querySelector('.customer360Core');
    if(!advanced||!core||advanced.dataset.relocated==='1')return;
    const disclosures=[...core.querySelectorAll(':scope > .opDisclosure')];
    const activity=disclosures.find(node=>text(node.querySelector('summary > span'))==='Activity');
    advanced.dataset.relocated='1';
    if(activity)core.insertBefore(advanced,activity);else core.appendChild(advanced);
  }

  function foldPaymentIncidents(){
    const sections=[...document.querySelectorAll('.content > section.section')];
    const incident=sections.find(section=>text(section.querySelector('.sectionHead h2'))==='Payment incidents');
    if(!incident||incident.dataset.folded==='1')return;
    const payments=[...document.querySelectorAll('.customer360Core > .opDisclosure')].find(node=>text(node.querySelector('summary > span'))==='Payments');
    const body=payments?.querySelector('.opDisclosureBody');
    if(!body)return;
    incident.dataset.folded='1';incident.classList.add('customerPaymentIncidentsFolded');body.appendChild(incident);
  }

  function plusDays(dateText,days){const date=new Date(`${dateText}T00:00:00Z`);if(Number.isNaN(date.getTime()))return'';date.setUTCDate(date.getUTCDate()+Number(days||30));return date.toISOString().slice(0,10);}

  function wireManualGrantForms(){
    document.querySelectorAll('form.manualGrantCompact:not([data-generic-wired])').forEach(form=>{
      form.dataset.genericWired='1';
      const plan=form.querySelector('[name="planId"]'),start=form.querySelector('[name="startDate"]'),end=form.querySelector('[name="endDate"]'),amount=form.querySelector('[name="amount"]'),currency=form.querySelector('[name="currency"]');
      if(!plan||!start||!end)return;
      const sync=resetCommercial=>{const option=plan.options[plan.selectedIndex];if(!option)return;end.value=plusDays(start.value,option.dataset.days);if(resetCommercial){if(amount)amount.value=option.dataset.amount||'0.00';if(currency)currency.value=option.dataset.currency||'GBP';}};
      plan.addEventListener('change',()=>sync(true));start.addEventListener('change',()=>sync(false));
    });
  }

  function enhance(){alignBreadcrumb();cleanLegacyHeader();identifyCards();restoreVisibleCardActions();polishPlansCard();polishDangerCard();moveAdvancedIntoBottomStack();foldPaymentIncidents();wireManualGrantForms();}
  enhance();
  const observer=new MutationObserver(enhance);observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
})();
