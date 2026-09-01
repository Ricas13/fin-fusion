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
  const status=field?ensureStatus(field):null;
  const csrfToken=document.querySelector('input[name="_csrf"]')?.value||'';
  let timer=null,requestId=0,lastPreview=null;

  function ensureStatus(input){let node=document.querySelector('[data-promo-status]');if(!node){const panel=input.closest('.sharedPromoPanel'),line=panel&&panel.querySelector('.sharedPromoLine');node=document.createElement('div');node.className='promoStatus';node.dataset.promoStatus='';(line||input).insertAdjacentElement('afterend',node);}node.setAttribute('aria-live','polite');return node;}
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function normalized(){return field?String(field.value||'').trim().toUpperCase().slice(0,40):'';}
  function targets(){return Array.from(document.querySelectorAll('[data-promo-target]'));}
  function cards(){return Array.from(document.querySelectorAll('[data-plan-code]'));}
  function money(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:currency||'USD',currencyDisplay:'narrowSymbol'}).format(Number(minor||0)/100);}catch(_){return `${currency||'USD'} ${(Number(minor||0)/100).toFixed(2)}`;}}
  function sync(){const value=normalized();if(field)field.value=value;for(const input of targets())input.value=value;}
  function setStatus(message,state){if(!status)return;status.textContent=message||'';status.dataset.state=state||'';}
  function prepareCard(card){const price=card.querySelector('[data-plan-price]');if(price&&!price.dataset.originalPrice)price.dataset.originalPrice=price.textContent.trim();}
  function prepareCards(){for(const card of cards())prepareCard(card);}
  function resetCard(card){const price=card.querySelector('[data-plan-price]'),note=card.querySelector('[data-promo-price-note]');if(price&&price.dataset.originalPrice)price.textContent=price.dataset.originalPrice;if(note){note.hidden=true;note.textContent='';}card.classList.remove('promoApplied');}
  function resetCards(){for(const card of cards())resetCard(card);}
  function discountedMinor(base,row){if(!row)return base;if(row.discountType==='percent')return Math.max(0,Math.round(base*(100-Number(row.percentOff||0))/100));if(row.discountType==='fixed')return Math.max(0,base-Number(row.fixedOffMinor||0));return Number.isFinite(Number(row.finalMinor))?Number(row.finalMinor):base;}
  function applyPreview(payload){
    lastPreview=payload||null;resetCards();
    if(!payload||!payload.valid){setStatus(payload?.message||'That promo code is not valid for the available plans.','error');return;}
    const planCards=cards();if(!planCards.length){setStatus('Promo code is valid for eligible plans. The exact discounted amount will be confirmed before payment.','success');return;}
    for(const card of planCards){const code=card.dataset.planCode,row=payload.plans&&payload.plans[code];if(!row||!row.valid)continue;const price=card.querySelector('[data-plan-price]'),note=card.querySelector('[data-promo-price-note]');if(!price)continue;const base=Number(card.dataset.planBaseMinor||row.baseMinor||0),currency=card.dataset.planCurrency||row.currency,final=discountedMinor(base,row),original=money(base,currency),discounted=money(final,currency);price.textContent=discounted;card.classList.add('promoApplied');if(note){const saving=Math.max(0,base-final);note.textContent=saving>0?`${original} normally · save ${money(saving,currency)} on this payment`:'Promo applies to this plan';note.hidden=false;}}
    setStatus(payload.message,'success');
  }
  async function preview(){if(!field)return;sync();const code=normalized(),id=++requestId;if(!code){lastPreview=null;resetCards();setStatus('Stripe subscription promos reduce the first payment. PayPal recurring plans cannot be repriced, so promo checkout uses PayPal one-time payment.','');return;}setStatus('Checking promo code…','pending');try{const response=await fetch('/account/discount-preview?code='+encodeURIComponent(code),{headers:{Accept:'application/json'},credentials:'same-origin'}),payload=await response.json();if(id!==requestId)return;applyPreview(payload);}catch(_){if(id!==requestId)return;lastPreview=null;resetCards();setStatus('Promo preview is unavailable right now. You can still enter the code at checkout.','error');}}
  function schedule(){sync();clearTimeout(timer);timer=setTimeout(preview,350);}

  function providerLabel(provider){return provider==='stripe'?'Stripe':provider==='paypal'?'PayPal':'Plisio';}
  function buttonClass(provider){return provider==='stripe'?'stripe':provider==='paypal'?'paypal':'primary';}
  function accessLabel(kind,quantity){return kind==='households'?`${quantity} household connection${quantity===1?'':'s'} · unlimited streams & devices`:`${quantity} concurrent stream${quantity===1?'':'s'}`;}
  function checkoutForm(plan,variant,provider,mode,label){return `<form class="plainForm checkoutForm" method="post" action="/account/checkout/${esc(provider)}"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="planCode" value="${esc(plan.code)}"><input type="hidden" name="accessQuantity" value="${esc(variant.quantity)}">${mode?`<input type="hidden" name="checkoutMode" value="${esc(mode)}">`:''}<input type="hidden" name="discountCode" data-promo-target value="${esc(normalized())}"><button class="button ${buttonClass(provider)} full" type="submit">${esc(label)}</button></form>`;}
  function availableModes(variant,provider){return(variant.paymentOptions||[]).filter(option=>option.provider===provider).map(option=>option.checkoutMode);}
  function selectedOption(plan,select){return plan.variants.find(variant=>Number(variant.quantity)===Number(select.value))||plan.variants[0];}
  function actionMarkup(plan,variant){
    if(plan.currentPlan&&Number(plan.currentQuantity)===Number(variant.quantity))return '<span class="button secondary full" aria-disabled="true">Current access allowance</span>';
    if(variant.soldOut)return '<span class="button secondary full" aria-disabled="true">Currently full for this allowance</span>';
    if(plan.currentProvider==='paypal'&&!plan.currentCancelAtPeriodEnd)return '<div class="paymentNote">Stop the current PayPal renewal before changing this access allowance.</div><a class="button secondary full" href="#renewal-control">Stop PayPal renewal first</a>';
    if(plan.currentProvider){
      const provider=plan.currentProvider,modes=availableModes(variant,provider);
      if(!modes.includes('subscription'))return `<div class="paymentNote">${esc(providerLabel(provider))} recurring billing is not configured for this access allowance.</div><span class="button secondary full" aria-disabled="true">Option unavailable</span>`;
      const label=provider==='stripe'?'Update with Stripe':'Record PayPal change';
      return checkoutForm(plan,variant,provider,'subscription',label);
    }
    const providers=['stripe','paypal','plisio'],parts=[];
    for(const provider of providers){const modes=availableModes(variant,provider);if(!modes.length)continue;const unique=Array.from(new Set(modes)),mode=unique.length===1?unique[0]:null,label=provider==='plisio'?'Plisio · One-off payment':`Continue with ${providerLabel(provider)}`;parts.push(checkoutForm(plan,variant,provider,mode,label));}
    return parts.join('')||'<span class="button secondary full" aria-disabled="true">No payment method available</span>';
  }
  function applyVariant(plan,card,select){
    const variant=selectedOption(plan,select);if(!variant)return;
    card.dataset.planBaseMinor=String(variant.priceMinor);card.dataset.planCurrency=variant.currency||card.dataset.planCurrency||'GBP';
    const price=card.querySelector('[data-plan-price]');if(price){price.dataset.originalPrice=variant.priceLabel||money(variant.priceMinor,variant.currency);price.textContent=price.dataset.originalPrice;}
    let access=card.querySelector('[data-dashboard-access-feature]');if(!access){const list=card.querySelector('.featureList');if(list){access=document.createElement('li');access.dataset.dashboardAccessFeature='';list.prepend(access);const original=list.children[1];if(original&&/stream|household/i.test(original.textContent||''))original.remove();}}
    if(access)access.textContent=accessLabel(plan.kind,variant.quantity);
    let scarcity=card.querySelector('[data-dashboard-variant-scarcity]');if(!scarcity){scarcity=document.createElement('div');scarcity.className='accessMeta';scarcity.dataset.dashboardVariantScarcity='';select.closest('.field')?.insertAdjacentElement('afterend',scarcity);}if(scarcity)scarcity.textContent=variant.scarcity||'Available';
    const actions=card.querySelector('.planActions');if(actions)actions.innerHTML=actionMarkup(plan,variant);
    card.classList.toggle('soldOut',Boolean(variant.soldOut));
    sync();
    if(lastPreview&&normalized())applyPreview(lastPreview);else resetCard(card);
  }
  function installVariantPicker(plan){
    const card=document.querySelector(`[data-plan-code="${CSS.escape(plan.code)}"]`);if(!card||card.dataset.variantPickerReady==='1')return;card.dataset.variantPickerReady='1';
    const selector=document.createElement('div');selector.className='field accessVariantField';selector.innerHTML=`<label>${plan.kind==='households'?'Household connections':'Concurrent streams'}</label><select class="input" data-dashboard-variant-selector>${plan.variants.map(variant=>`<option value="${esc(variant.quantity)}" ${Number(variant.quantity)===Number(plan.preferredQuantity)?'selected':''}>${esc(accessLabel(plan.kind,variant.quantity))} · ${esc(variant.priceLabel)}${variant.soldOut?' · Currently full':''}</option>`).join('')}</select>`;
    const description=card.querySelector('.planDescription'),features=card.querySelector('.featureList');(features||description)?.insertAdjacentElement('beforebegin',selector);
    const select=selector.querySelector('select');select.addEventListener('change',()=>applyVariant(plan,card,select));applyVariant(plan,card,select);
  }
  async function loadVariants(){
    if(!cards().length)return;
    try{const response=await fetch('/account/plan-variants',{headers:{Accept:'application/json'},credentials:'same-origin'});if(!response.ok)return;const payload=await response.json();for(const plan of payload.plans||[])installVariantPicker(plan);}catch(_){/* Keep server-rendered base plan actions as fallback. */}
  }

  prepareCards();
  if(field){field.addEventListener('input',schedule);field.addEventListener('change',preview);const clear=document.querySelector('[data-clear-promo]');if(clear)clear.addEventListener('click',()=>{field.value='';sync();preview();field.focus();});sync();}
  document.addEventListener('submit',event=>{if(event.target&&event.target.matches('.checkoutForm'))sync();},true);
  loadVariants();
})();