'use strict';
(function(){
  async function syncPaymentReadiness(){
    try{
      const response=await fetch('/account/checkout/readiness',{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});
      if(!response.ok)return;
      const readiness=await response.json();
      for(const provider of ['stripe','paypal','plisio']){
        if(readiness?.[provider])continue;
        const elements=new Set([
          ...document.querySelectorAll(`form.checkoutForm[action="/account/checkout/${provider}"]`),
          ...document.querySelectorAll(`[data-payment-key^="${provider}:"]`)
        ]);
        for(const element of elements){element.hidden=true;element.setAttribute('aria-hidden','true');element.querySelectorAll?.('button').forEach(button=>{button.disabled=true;});}
      }
    }catch(_){
      // The server-side checkout gate remains authoritative. Avoid turning a
      // transient readiness-probe failure into a misleading client-side outage.
    }
  }
  syncPaymentReadiness();

  const field=document.querySelector('[data-shared-promo]');
  if(!field)return;
  let status=document.querySelector('[data-promo-status]');
  if(!status){
    const panel=field.closest('.sharedPromoPanel'),line=panel&&panel.querySelector('.sharedPromoLine');
    status=document.createElement('div');
    status.className='promoStatus';
    status.dataset.promoStatus='';
    (line||field).insertAdjacentElement('afterend',status);
  }
  status.setAttribute('aria-live','polite');
  const targets=()=>Array.from(document.querySelectorAll('[data-promo-target]'));
  const cards=()=>Array.from(document.querySelectorAll('[data-plan-code]'));
  let timer=null,requestId=0;

  function normalized(){return String(field.value||'').trim().toUpperCase().slice(0,40);}
  function sync(){const value=normalized();field.value=value;for(const input of targets())input.value=value;}
  function money(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:currency||'USD',currencyDisplay:'narrowSymbol'}).format(Number(minor||0)/100);}catch(_){return `${currency||'USD'} ${(Number(minor||0)/100).toFixed(2)}`;}}
  function resetCards(){for(const card of cards()){const price=card.querySelector('[data-plan-price]'),note=card.querySelector('[data-promo-price-note]');if(price&&price.dataset.originalPrice)price.textContent=price.dataset.originalPrice;if(note){note.hidden=true;note.textContent='';}card.classList.remove('promoApplied');}}
  function prepareCards(){for(const card of cards()){const price=card.querySelector('[data-plan-price]');if(price&&!price.dataset.originalPrice)price.dataset.originalPrice=price.textContent.trim();}}
  function setStatus(message,state){status.textContent=message||'';status.dataset.state=state||'';}
  function applyPreview(payload){
    resetCards();
    if(!payload||!payload.valid){setStatus(payload?.message||'That promo code is not valid for the available plans.','error');return;}
    const planCards=cards();
    if(!planCards.length){setStatus('Promo code is valid for eligible plans. The exact discounted amount will be confirmed before payment.','success');return;}
    for(const card of planCards){const code=card.dataset.planCode,row=payload.plans&&payload.plans[code];if(!row||!row.valid)continue;const price=card.querySelector('[data-plan-price]'),note=card.querySelector('[data-promo-price-note]');if(!price)continue;const original=money(row.baseMinor,row.currency),discounted=money(row.finalMinor,row.currency);price.textContent=discounted;card.classList.add('promoApplied');if(note){const saving=Math.max(0,Number(row.baseMinor||0)-Number(row.finalMinor||0));note.textContent=saving>0?`${original} normally · save ${money(saving,row.currency)} on this payment`:`Promo applies to this plan`;note.hidden=false;}}
    setStatus(payload.message,'success');
  }
  async function preview(){sync();const code=normalized();const id=++requestId;if(!code){resetCards();setStatus('Stripe subscription promos reduce the first payment. PayPal recurring plans cannot be repriced, so promo checkout uses PayPal one-time payment.','');return;}setStatus('Checking promo code…','pending');try{const response=await fetch('/account/discount-preview?code='+encodeURIComponent(code),{headers:{Accept:'application/json'},credentials:'same-origin'}),payload=await response.json();if(id!==requestId)return;applyPreview(payload);}catch(_){if(id!==requestId)return;resetCards();setStatus('Promo preview is unavailable right now. You can still enter the code at checkout.','error');}}
  function schedule(){for(const input of targets())input.value=String(field.value||'').trim().slice(0,40);clearTimeout(timer);timer=setTimeout(preview,350);}

  prepareCards();
  field.addEventListener('input',schedule);
  field.addEventListener('change',preview);
  document.addEventListener('submit',event=>{if(event.target&&event.target.matches('.checkoutForm'))sync();},true);
  const clear=document.querySelector('[data-clear-promo]');
  if(clear)clear.addEventListener('click',()=>{field.value='';sync();preview();field.focus();});
  sync();
})();