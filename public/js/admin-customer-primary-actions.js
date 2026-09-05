'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  const match=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(!match)return;
  const customerId=match[1];
  const text=node=>String(node?.textContent||'').trim();
  const advancedLabels=new Set(['Reconcile','Fix access','Reconcile access','Sync roles / reconcile','Provision / re-provision','Re-provision / resync','Create / provision','Revoke current plan now','Stop renewal','Resume renewal']);

  const style=document.createElement('style');
  style.textContent='.content>.pageHeader{display:none!important}.topBarActions>a[href="/admin/users"]{display:none!important}.opMoreActions{grid-column:1/-1}.opMoreActions>summary{cursor:pointer;list-style:none;font-size:.61rem;font-weight:750;color:var(--muted,#9aa7b5);padding:5px 7px;border:1px solid var(--border,#29333d);border-radius:6px;text-align:center}.opMoreActions>summary::-webkit-details-marker{display:none}.opMoreActionsBody{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;width:100%;padding-top:6px}.opMoreActionsBody .plainForm,.opMoreActionsBody .button{width:100%}.customerPaymentIncidentsFolded{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}.customerPaymentIncidentsFolded>.sectionHead{margin-bottom:6px}.customerPaymentIncidentsFolded>.sectionHead h2{font-size:.75rem}.mockDangerWarning{grid-column:1/-1;border:1px solid rgba(215,154,59,.45);border-radius:6px;background:rgba(141,90,18,.14);padding:8px 9px;color:#d9ae67;font-size:.61rem;line-height:1.3}.mockCardButton{display:inline-flex;align-items:center;justify-content:center;min-height:27px;padding:4px 5px;border:1px solid #315a78;border-radius:6px;background:transparent;color:var(--text);font-size:.60rem;cursor:pointer;text-decoration:none}.mockCardButton:hover{border-color:#4fb8f4}';
  document.head.appendChild(style);

  function customerName(){return text(document.querySelector('.customerMockName h1'))||text(document.querySelector('.customerMockEmail'))||'Customer';}
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
      if(title==='Plans & Subscriptions')card.id='customer-plans';
      if(title==='Jellyfin / Emby')card.id='customer-jellyfin';
      if(title==='Stremio')card.id='customer-stremio';
      if(title==='Overseerr')card.id='customer-overseerr';
      if(title==='Customer / Portal')card.id='customer-portal';
      if(title==='Discord')card.id='customer-discord';
      if(title==='Access / Holds')card.id='customer-holds';
      if(title==='Danger Zone')card.id='customer-danger';
    });
  }

  function compactTechnicalActions(){
    document.querySelectorAll('.opCard .opActions').forEach(actions=>{
      if(actions.querySelector(':scope > details.opMoreActions'))return;
      const technical=[...actions.children].filter(node=>advancedLabels.has(text(node.querySelector('button,a')||node)));
      if(!technical.length)return;
      const details=document.createElement('details');details.className='opMoreActions';
      const summary=document.createElement('summary');summary.textContent='More / repair';details.appendChild(summary);
      const body=document.createElement('div');body.className='opMoreActionsBody';details.appendChild(body);
      for(const node of technical)body.appendChild(node);
      actions.appendChild(details);
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
    const hint=card.querySelector('.opHint');if(hint)hint.textContent='Permanently delete this customer or a service account. Normal access removal belongs in the cards above.';
    card.querySelectorAll('.dangerNote').forEach(node=>node.remove());
    const actions=card.querySelector('.opActions');
    if(actions){const warning=document.createElement('div');warning.className='mockDangerWarning';warning.textContent='⚠ This cannot be undone. Billing history is retained for compliance.';actions.appendChild(warning);}
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

  function enhance(){alignBreadcrumb();cleanLegacyHeader();identifyCards();compactTechnicalActions();polishPlansCard();polishDangerCard();moveAdvancedIntoBottomStack();foldPaymentIncidents();wireManualGrantForms();}
  enhance();
  const observer=new MutationObserver(enhance);observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
})();
