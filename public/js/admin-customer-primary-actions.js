'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  const match=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(!match)return;
  const customerId=match[1];
  const text=node=>String(node?.textContent||'').trim();
  const advancedLabels=new Set(['Reconcile','Fix access','Reconcile access','Sync roles / reconcile','Provision / re-provision','Re-provision / resync','Create / provision']);

  const style=document.createElement('style');
  style.textContent='.opMoreActions{grid-column:1/-1}.opMoreActions>summary{cursor:pointer;list-style:none;font-size:.61rem;font-weight:750;color:var(--muted,#9aa7b5);padding:5px 7px;border:1px solid var(--border,#29333d);border-radius:6px;text-align:center}.opMoreActions>summary::-webkit-details-marker{display:none}.opMoreActionsBody{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;width:100%;padding-top:6px}.opMoreActionsBody .plainForm,.opMoreActionsBody .button{width:100%}';
  document.head.appendChild(style);

  function cleanLegacyHeader(){
    document.querySelectorAll('a,button').forEach(node=>{
      const label=text(node);
      if(label==='Change Jellyfin password'&& !node.closest('.approvedCustomerHero') && !node.closest('.customer360Core'))node.remove();
    });
    document.querySelectorAll(`form[action="/admin/users/${customerId}/impersonate"]`).forEach(form=>{
      if(!form.closest('.customerPrimaryActions')&&!form.closest('.approvedCustomerHero'))form.remove();
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

  function moveAdvancedIntoBottomStack(){
    const advanced=document.querySelector(':scope body .approvedAdvanced');
    const core=document.querySelector('.customer360Core');
    if(!advanced||!core||advanced.dataset.relocated==='1')return;
    const disclosures=[...core.querySelectorAll(':scope > .opDisclosure')];
    const activity=disclosures.find(node=>text(node.querySelector('summary > span'))==='Activity');
    advanced.dataset.relocated='1';
    if(activity)core.insertBefore(advanced,activity);else core.appendChild(advanced);
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

  function enhance(){cleanLegacyHeader();identifyCards();compactTechnicalActions();moveAdvancedIntoBottomStack();wireManualGrantForms();}
  enhance();
  const observer=new MutationObserver(enhance);observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
})();
