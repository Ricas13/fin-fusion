'use strict';

document.querySelectorAll('[data-access-card]').forEach(function(card){
  const select=card.querySelector('[data-access-selector]');
  if(!select)return;
  const price=card.querySelector('[data-choice-price]');
  const accessFeature=card.querySelector('[data-access-feature]');
  const scarcity=card.querySelector('[data-scarcity-feature]');
  const soldNote=card.querySelector('[data-variant-sold]');
  const kind=String(card.dataset.accessKind||'streams');

  function accessLabel(quantity){
    if(kind==='households')return quantity+' household'+(quantity===1?'':'s')+' · unlimited streams & devices';
    return quantity+' concurrent stream'+(quantity===1?'':'s');
  }

  function sync(){
    const option=select.options[select.selectedIndex];
    const quantity=Number(option.value||1);
    const payments=new Set(String(option.dataset.payments||'').split(',').filter(Boolean));
    const sold=option.dataset.sold==='1';
    if(price)price.textContent=option.dataset.price||price.textContent;
    if(accessFeature)accessFeature.textContent=accessLabel(quantity);
    if(scarcity)scarcity.textContent=option.dataset.scarcity||'Available';
    if(soldNote)soldNote.style.display=sold?'block':'none';
    card.querySelectorAll('input[name="accessQuantity"]').forEach(function(input){input.value=String(quantity);});
    card.querySelectorAll('[data-payment-key]').forEach(function(el){
      const allowed=!sold&&payments.has(el.dataset.paymentKey);
      el.style.display=allowed?'':'none';
      el.querySelectorAll('button').forEach(function(button){button.disabled=!allowed;});
    });
  }

  select.addEventListener('change',sync);
  sync();
});
