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

    /* The large duplicated action strip is now only a server-rendered source for
       controls that are relocated into the relevant Customer 360 cards. */
    .customerPrimaryActions{display:none!important}

    /* Approved Customer 360 proportions */
    .customerMockHero{margin:0 0 10px!important;gap:18px!important}
    .customerMockIdentity{grid-template-columns:74px minmax(0,1fr)!important;gap:18px!important}
    .customerMockAvatar{width:74px!important;height:74px!important}
    .customerMockName h2{font-size:1.24rem!important}
    .customerMockEmail{font-size:.80rem!important;margin-top:5px!important}
    .customerMockMeta{font-size:.62rem!important;margin-top:7px!important}
    .customerMockPills{margin-top:7px!important}
    .customerMockTopActions{gap:7px!important;margin-bottom:0!important;align-items:center!important}
    .customerMockTopActions>.plainForm{margin:0!important}
    .mockTopButton{min-height:30px!important;padding:5px 12px!important;border-radius:7px!important;font-size:.67rem!important}
    .customerMockMetrics{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:9px!important}
    .customerMockMetric{min-height:70px!important;padding:9px 12px!important;border-radius:8px!important;background:#101a23!important}
    .customerMockMetric small{font-size:.60rem!important}
    .customerMockMetric strong{font-size:.86rem!important;margin-top:4px!important}
    .customerMockMetric span{font-size:.60rem!important;margin-top:3px!important}

    .customerMockMore{position:relative;margin:0}
    .customerMockMore>summary{list-style:none;cursor:pointer;min-width:40px;padding-inline:10px!important}
    .customerMockMore>summary::-webkit-details-marker{display:none}
    .customerMockMoreMenu{position:absolute;right:0;top:calc(100% + 5px);z-index:80;width:190px;padding:5px;border:1px solid #314352;border-radius:8px;background:#101922;box-shadow:0 14px 34px rgba(0,0,0,.45);display:grid;gap:2px}
    .customerMockMoreMenu a,.customerMockMoreMenu button{box-sizing:border-box;width:100%;border:0;border-radius:5px;background:transparent;color:#dce7ef;text-decoration:none;text-align:left;padding:8px 9px;font:inherit;font-size:.66rem;cursor:pointer}
    .customerMockMoreMenu a:hover,.customerMockMoreMenu button:hover{background:#182633}

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
    .customer360Core .opActions .button,.mockCardButton,.mockDangerButton,.mockForceButton{box-sizing:border-box;min-height:27px!important;padding:4px 6px!important;border-radius:6px!important;font-size:.59rem!important}
    .customer360Core .opActions form[action$="/manage/reconcile"]{display:none!important}

    /* Keep card actions visible; only the duplicated generic reconcile is hidden above. */
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
    .mockCardButton{display:inline-flex;align-items:center;justify-content:center;border:1px solid #315a78;background:transparent;color:var(--text);cursor:pointer;text-decoration:none;text-align:center}
    .mockCardButton:hover{border-color:#4fb8f4}
    .compactMovedAction{position:relative;margin:0}
    .compactMovedAction>summary{list-style:none;width:100%;cursor:pointer}
    .compactMovedAction>summary::-webkit-details-marker{display:none}

    /* True Jellyfin break-glass control: this is the existing server-side force
       workflow, moved into the Jellyfin card rather than the generic authority button. */
    .compactForceAction{position:relative;margin:0}
    .compactForceAction>summary{list-style:none;width:100%;cursor:pointer}
    .compactForceAction>summary::-webkit-details-marker{display:none}
    .mockForceButton{display:flex;align-items:center;justify-content:center;border:1px solid #2aa9ef;background:rgba(24,86,122,.28);color:#e8f7ff;font-weight:750;text-align:center}
    .mockForceButton:hover{border-color:#68ceff;background:rgba(29,111,158,.34)}
    .compactForcePopover{position:absolute;z-index:90;left:0;top:calc(100% + 6px);width:min(440px,88vw);border:1px solid #35566d;border-radius:9px;padding:10px;background:#0d1821;box-shadow:0 18px 42px rgba(0,0,0,.52)}
    .forceBypassNote{font-size:.61rem;line-height:1.4;color:#b8c9d6;margin:0 0 8px}
    .forceBypassNote strong{color:#fff}
    .compactForceForm{display:grid!important;grid-template-columns:1fr!important;gap:6px!important;margin:0!important}
    .compactForceForm .input{width:100%;min-width:0;min-height:30px;font-size:.65rem}
    .compactForceForm .button{width:100%!important;min-height:30px!important}

    /* Danger Zone actions should read unmistakably as actions, not text rows. */
    #customer-danger{border-color:rgba(224,77,89,.55)!important}
    #customer-danger .opActions{grid-template-columns:1fr!important;gap:7px!important}
    #customer-danger .dangerAction,#customer-danger .compactDangerAction{margin:0!important;padding:0!important;border:0!important;position:relative}
    #customer-danger .dangerAction>summary,.mockDangerButton{box-sizing:border-box;display:flex;width:100%;align-items:center;justify-content:center;min-height:30px!important;padding:6px 9px!important;border:1px solid rgba(224,77,89,.72);border-radius:6px;background:rgba(133,38,48,.24);color:#ff9ca3;font-size:.61rem!important;font-weight:800;cursor:pointer;text-align:center;list-style:none}
    #customer-danger .dangerAction>summary:hover,.mockDangerButton:hover{border-color:#ff6c77;background:rgba(153,42,53,.35);color:#ffd4d7}
    #customer-danger .dangerAction[open]>summary,#customer-danger .compactDangerAction[open]>.mockDangerButton{background:rgba(153,42,53,.42)}
    #customer-danger .dangerAction>summary::-webkit-details-marker,.mockDangerButton::-webkit-details-marker{display:none}
    #customer-danger .dangerAction>p{margin:7px 2px 7px!important}
    #customer-danger .dangerAction>.plainForm,#customer-danger .compactDangerAction>.actionPopover .plainForm{width:100%}
    #customer-danger .dangerAction .button.danger,#customer-danger .compactDangerAction .button.danger{width:100%!important;min-height:29px!important}
    #customer-danger .actionPopover{right:0;left:auto}

    @media(max-width:1450px){.customer360Core .opGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
    @media(max-width:620px){.customer360Core .opGrid,.customerMockMetrics{grid-template-columns:1fr!important}.customerMockMoreMenu{right:auto;left:0}.compactForcePopover,.compactMovedAction .actionPopover,#customer-danger .actionPopover{position:fixed!important;left:10px!important;right:10px!important;top:20vh!important;width:auto!important}}
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

  function wireMoreMenu(){
    const top=document.querySelector('.customerMockTopActions');
    if(!top||top.querySelector('.customerMockMore'))return;
    const trigger=[...top.querySelectorAll('button')].find(node=>text(node)==='•••'||node.title==='More customer actions');
    if(!trigger)return;
    const details=document.createElement('details');details.className='customerMockMore';
    const summary=document.createElement('summary');summary.className='mockTopButton';summary.title='More customer actions';summary.textContent='•••';
    const menu=document.createElement('div');menu.className='customerMockMoreMenu';
    const password=document.querySelector(`a[href="/admin/customer-jellyfin-password?customerId=${customerId}"]`);
    if(password){const link=document.createElement('a');link.href=password.href;link.textContent='Reset Jellyfin password';menu.appendChild(link);}
    const advanced=document.createElement('button');advanced.type='button';advanced.textContent='Advanced / Recovery tools';
    advanced.addEventListener('click',()=>{details.open=false;const panel=document.querySelector('.approvedAdvanced');if(panel){panel.open=true;panel.scrollIntoView({block:'center',behavior:'smooth'});}});
    menu.appendChild(advanced);
    const back=document.createElement('a');back.href='/admin/users';back.textContent='Back to all customers';menu.appendChild(back);
    details.append(summary,menu);trigger.replaceWith(details);
  }

  function cleanLegacyHeader(){
    document.querySelectorAll('a,button').forEach(node=>{
      const label=text(node);
      if(label==='Change Jellyfin password'&&!node.closest('.customerMockHero')&&!node.closest('.customerPrimaryActions')&&!node.closest('.customer360Core'))node.remove();
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

  function relocatePrimaryActions(){
    const primary=document.querySelector('.customerPrimaryActions');
    if(!primary)return;
    const portalActions=document.querySelector('#customer-portal .opActions');
    const plansActions=document.querySelector('#customer-plans .opActions');
    const dangerActions=document.querySelector('#customer-danger .opActions');

    const recovery=primary.querySelector('a.actionTile[href*="/portal-credential-recovery"]');
    if(recovery&&portalActions){
      recovery.className='mockCardButton';
      recovery.textContent='Recover portal account';
      portalActions.appendChild(recovery);
    }

    const automation=[...primary.querySelectorAll('form')].find(form=>{
      const action=form.getAttribute('action')||'';
      return action.endsWith('/manage/make-permanent-user')||action.endsWith('/manage/normal-automation');
    });
    if(automation&&portalActions){
      const returning=(automation.getAttribute('action')||'').endsWith('/manage/normal-automation');
      automation.className='plainForm';
      const button=automation.querySelector('button');
      if(button){button.className='mockCardButton';button.textContent=returning?'Return to automation':'Make customer permanent';}
      portalActions.appendChild(automation);
    }

    const grant=primary.querySelector('.actionTileDetails.grant');
    if(grant&&plansActions){
      grant.classList.add('compactMovedAction');
      const summary=grant.querySelector(':scope > summary');
      if(summary){summary.className='mockCardButton';summary.textContent='Add plan manually';}
      plansActions.prepend(grant);
    }

    const removeAll=primary.querySelector('.actionTileDetails.danger');
    if(removeAll&&dangerActions){
      removeAll.classList.add('compactDangerAction');
      const summary=removeAll.querySelector(':scope > summary');
      if(summary){summary.className='mockDangerButton';summary.textContent='Remove all service access…';}
      dangerActions.prepend(removeAll);
    }

    primary.remove();
  }

  function relocateTrueForceAccess(){
    const card=document.getElementById('customer-jellyfin');
    const actions=card?.querySelector('.opActions');
    if(!actions||actions.querySelector('[data-true-force-relocated="1"]'))return;

    const forceForm=document.querySelector('.approvedAdvanced form.forceAccessForm');
    if(forceForm){
      const genericPresent=card.querySelector('form[action$="/service-authority/jellyfin/present"]');
      if(genericPresent)genericPresent.remove();

      const details=document.createElement('details');
      details.className='compactForceAction';
      details.dataset.trueForceRelocated='1';
      const summary=document.createElement('summary');
      summary.className='mockForceButton';
      summary.textContent='Grant / force access';
      const popover=document.createElement('div');
      popover.className='compactForcePopover';
      const note=document.createElement('p');
      note.className='forceBypassNote';
      note.innerHTML='<strong>Break-glass access.</strong> This bypasses payment/refund holds, expiry, automatic server-pool admission and configured capacity. Automation cannot remove the forced access until it is returned to normal rules.';
      forceForm.classList.add('compactForceForm');
      const submit=forceForm.querySelector('button[type="submit"]');
      if(submit)submit.textContent='Force Jellyfin access';
      popover.append(note,forceForm);
      details.append(summary,popover);
      actions.prepend(details);
    }

    const reset=document.querySelector('.approvedAdvanced form[action$="/force-jellyfin-access/reset"]');
    if(reset){
      const genericAutomatic=card.querySelector('form[action$="/service-authority/jellyfin/automatic"]');
      if(genericAutomatic)genericAutomatic.remove();
      reset.className='plainForm';
      const button=reset.querySelector('button');
      if(button){button.className='mockCardButton';button.textContent='Return to automatic';}
      actions.appendChild(reset);
    }
  }

  function polishPlansCard(){
    const card=document.getElementById('customer-plans');
    const actions=card?.querySelector('.opActions');
    if(!actions||actions.dataset.mockPolished==='1')return;
    actions.dataset.mockPolished='1';
    if(![...actions.querySelectorAll('button,a,summary')].some(node=>text(node)==='View billing history')){
      const billing=document.createElement('button');billing.type='button';billing.className='mockCardButton';billing.textContent='View billing history';
      billing.addEventListener('click',()=>{const payments=[...document.querySelectorAll('.customer360Core > .opDisclosure')].find(node=>text(node.querySelector('summary > span'))==='Payments');if(payments){payments.open=true;payments.scrollIntoView({block:'center',behavior:'smooth'});}});
      actions.appendChild(billing);
    }
  }

  function polishDangerCard(){
    const card=document.getElementById('customer-danger');
    if(!card||card.dataset.mockPolished==='1')return;
    card.dataset.mockPolished='1';
    const hint=card.querySelector('.opHint');if(hint)hint.textContent='Permanently delete this customer and all associated data, or use the scoped destructive actions below.';
    card.querySelectorAll('.dangerNote').forEach(node=>node.remove());
    const actions=card.querySelector('.opActions');
    if(actions){
      const warning=document.createElement('div');warning.className='mockDangerWarning';
      warning.textContent='⚠ Destructive actions require their existing guarded confirmation flow. Billing history is retained where required.';
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

  function enhance(){alignBreadcrumb();wireMoreMenu();cleanLegacyHeader();identifyCards();restoreVisibleCardActions();relocatePrimaryActions();relocateTrueForceAccess();polishPlansCard();polishDangerCard();moveAdvancedIntoBottomStack();foldPaymentIncidents();wireManualGrantForms();}
  enhance();
  requestAnimationFrame(enhance);
  setTimeout(enhance,250);
})();
