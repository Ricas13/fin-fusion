'use strict';

document.querySelectorAll('[data-access-card]').forEach(function(card){
  const select=card.querySelector('[data-access-selector]');
  if(!select)return;
  const price=card.querySelector('[data-choice-price],[data-plan-price]');
  const accessFeature=card.querySelector('[data-access-feature]');
  const scarcity=card.querySelector('[data-scarcity-feature]');
  const soldNote=card.querySelector('[data-variant-sold]');
  const currentChoice=card.querySelector('[data-current-choice]');
  const kind=String(card.dataset.accessKind||'streams');
  const currentQuantity=Math.max(0,Number(card.dataset.currentAccessQuantity||0));

  function accessLabel(quantity){
    if(kind==='households')return quantity+' household'+(quantity===1?'':'s')+' · unlimited streams & devices';
    return quantity+' concurrent stream'+(quantity===1?'':'s');
  }

  function paymentSet(option){return new Set(String(option?.dataset?.payments||'').split(',').filter(Boolean));}

  function selectInitialAvailable(){
    const current=select.options[select.selectedIndex];
    if(current&&currentQuantity>0&&Number(current.value)===currentQuantity)return;
    if(current&&current.dataset.sold!=='1'&&paymentSet(current).size)return;
    const options=Array.from(select.options);
    const next=options.findIndex(option=>option.dataset.sold!=='1'&&paymentSet(option).size);
    if(next>=0)select.selectedIndex=next;
  }

  function sync(){
    const option=select.options[select.selectedIndex];
    const quantity=Number(option.value||1);
    const payments=paymentSet(option);
    const currentSelected=currentQuantity>0&&quantity===currentQuantity;
    const sold=option.dataset.sold==='1'&&!currentSelected;
    if(price){
      const selectedPrice=option.dataset.price||price.textContent;
      price.textContent=selectedPrice;
      price.dataset.originalPrice=selectedPrice;
    }
    if(accessFeature)accessFeature.textContent=accessLabel(quantity);
    if(scarcity)scarcity.textContent=currentSelected?'Your current access':(option.dataset.scarcity||'Available');
    if(soldNote)soldNote.style.display=sold?'block':'none';
    if(currentChoice)currentChoice.style.display=currentSelected?'':'none';
    card.querySelectorAll('input[name="accessQuantity"]').forEach(function(input){input.value=String(quantity);});
    card.querySelectorAll('[data-payment-key]').forEach(function(el){
      const allowed=!sold&&!currentSelected&&payments.has(el.dataset.paymentKey);
      el.style.display=allowed?'':'none';
      el.querySelectorAll('button').forEach(function(button){button.disabled=!allowed;});
    });
  }

  select.addEventListener('change',sync);
  selectInitialAvailable();
  sync();
});
