'use strict';

document.querySelectorAll('[data-stream-card]').forEach(function(card){
  const select=card.querySelector('[data-stream-selector]');
  if(!select)return;
  const price=card.querySelector('[data-choice-price]');
  const streamFeature=card.querySelector('[data-stream-feature]');
  const scarcity=card.querySelector('[data-scarcity-feature]');
  const soldNote=card.querySelector('[data-variant-sold]');

  function sync(){
    const option=select.options[select.selectedIndex];
    const streams=Number(option.value||1);
    const payments=new Set(String(option.dataset.payments||'').split(',').filter(Boolean));
    const sold=option.dataset.sold==='1';
    if(price)price.textContent=option.dataset.price||price.textContent;
    if(streamFeature)streamFeature.textContent=streams+' concurrent stream'+(streams===1?'':'s');
    if(scarcity)scarcity.textContent=option.dataset.scarcity||'Available';
    if(soldNote)soldNote.style.display=sold?'block':'none';
    card.querySelectorAll('input[name="streams"]').forEach(function(input){input.value=String(streams);});
    card.querySelectorAll('[data-payment-key]').forEach(function(el){
      const allowed=!sold&&payments.has(el.dataset.paymentKey);
      el.style.display=allowed?'':'none';
      el.querySelectorAll('button').forEach(function(button){button.disabled=!allowed;});
    });
  }

  select.addEventListener('change',sync);
  sync();
});
