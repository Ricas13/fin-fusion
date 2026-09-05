'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  const match=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(!match)return;
  const customerId=match[1];

  const style=document.createElement('style');
  style.textContent='.opMoreActions{align-self:center}.opMoreActions>summary{cursor:pointer;list-style:none;font-size:.64rem;font-weight:750;color:var(--muted,#9aa7b5);padding:5px 7px;border:1px solid var(--border,#29333d);border-radius:7px}.opMoreActions>summary::-webkit-details-marker{display:none}.opMoreActionsBody{display:flex;gap:5px;flex-wrap:wrap;width:100%;padding-top:6px}.opMoreActionsBody .plainForm{display:inline-flex}';
  document.head.appendChild(style);

  const text=node=>String(node?.textContent||'').trim();
  const advancedLabels=new Set([
    'Reconcile','Fix access','Reconcile access','Sync roles / reconcile',
    'Provision / re-provision','Re-provision / resync','Create / provision'
  ]);

  function dedupePortal(){
    const forms=[...document.querySelectorAll(`form[action="/admin/users/${customerId}/impersonate"]`)];
    if(forms.length<2)return;
    const preferred=forms.find(form=>form.closest('.customerPortalTab'))||forms.find(form=>form.closest('.detailTabs'))||forms[0];
    for(const form of forms)if(form!==preferred)form.remove();
  }

  function identifyCards(){
    document.querySelectorAll('.opCard').forEach(card=>{
      const title=text(card.querySelector('.opCardHead h2'));
      if(title==='Plans & Subscriptions')card.id='customer-plans';
      if(title==='Jellyfin / Emby')card.id='customer-jellyfin';
      if(title==='Stremio')card.id='customer-stremio';
      if(title==='Overseerr')card.id='customer-overseerr';
      if(title==='Customer / Portal')card.id='customer-portal';
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

  function enhance(){dedupePortal();identifyCards();compactTechnicalActions();wireManualGrantForms();}
  enhance();
  const observer=new MutationObserver(enhance);observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
})();
