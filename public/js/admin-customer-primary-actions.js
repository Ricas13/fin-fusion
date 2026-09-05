'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  const match=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(!match)return;
  const customerId=match[1];

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

  function enhance(){dedupePortal();identifyCards();compactTechnicalActions();}
  enhance();
  const observer=new MutationObserver(enhance);observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
})();
