'use strict';
(function(){
  const field=document.querySelector('[data-shared-promo]');
  if(!field)return;
  const status=document.querySelector('[data-promo-status]');
  const targets=()=>Array.from(document.querySelectorAll('[data-promo-target]'));
  const cards=()=>Array.from(document.querySelectorAll('[data-plan-code]'));
  let timer=null,requestId=0;

  function normalized(){return String(field.value||'').trim().toUpperCase().slice(0,40);}
  function sync(){const value=normalized();field.value=value;for(const input of targets())input.value=value;}
  function money(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:currency||'USD',currencyDisplay:'narrowSymbol'}).format(Number(minor||0)/100);}catch(_){return `${currency||'USD'} ${(Number(minor||0)/100).toFixed(2)}`;}}
  function resetCards(){for(const card of cards()){const price=card.querySelector('[data-plan-price]'),note=card.querySelector('[data-promo-price-note]');if(price&&price.dataset.originalPrice)price.textContent=price.dataset.originalPrice;if(note){note.hidden=true;note.textContent='';}card.classList.remove('promoApplied');}}
  function prepareCards(){for(const card of cards()){const price=card.querySelector('[data-plan-price]');if(price&&!price.dataset.originalPrice)price.dataset.originalPrice=price.textContent.trim();}}
  function setStatus(message,state){if(!status)return;status.textContent=message||'';status.dataset.state=state||'';}
  function applyPreview(payload){resetCards();if(!payload||!payload.valid){setStatus(payload?.message||'That promo code is not valid for the available plans.','error');return;}for(const card of cards()){const code=card.dataset.planCode,row=payload.plans&&payload.plans[code];if(!row||!row.valid)continue;const price=card.querySelector('[data-plan-price]'),note=card.querySelector('[data-promo-price-note]');if(!price)continue;const original=money(row.baseMinor,row.currency),discounted=money(row.finalMinor,row.currency);price.textContent=discounted;card.classList.add('promoApplied');if(note){const saving=Math.max(0,Number(row.baseMinor||0)-Number(row.finalMinor||0));note.textContent=saving>0?`${original} normally · save ${money(saving,row.currency)} on this payment`:`Promo applies to this plan`;note.hidden=false;}}setStatus(payload.message,'success');}
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