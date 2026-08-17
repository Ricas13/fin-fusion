'use strict';

(function(){
  function sync(list){
    const key=list.dataset.orderList,output=document.querySelector(`[data-order-output="${key}"]`);if(!output)return;
    output.value=[...list.querySelectorAll('[data-order-item]')].map(item=>item.dataset.id).join(',');
  }
  function syncAll(){document.querySelectorAll('[data-order-list]').forEach(sync)}
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-move]');if(!button)return;
    const item=button.closest('[data-order-item]'),list=item?.closest('[data-order-list]');if(!item||!list)return;
    if(button.dataset.move==='up'&&item.previousElementSibling)list.insertBefore(item,item.previousElementSibling);
    if(button.dataset.move==='down'&&item.nextElementSibling)list.insertBefore(item.nextElementSibling,item);
    sync(list);item.querySelector(`[data-move="${button.dataset.move}"]`)?.focus();
  });
  document.addEventListener('dragstart',event=>{const item=event.target.closest('[data-order-item]');if(!item)return;item.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',item.dataset.id||'')});
  document.addEventListener('dragend',event=>{const item=event.target.closest('[data-order-item]');item?.classList.remove('dragging');document.querySelectorAll('.dragTarget').forEach(x=>x.classList.remove('dragTarget'));syncAll()});
  document.addEventListener('dragover',event=>{const target=event.target.closest('[data-order-item]'),dragging=document.querySelector('[data-order-item].dragging');if(!target||!dragging||target===dragging||target.closest('[data-order-list]')!==dragging.closest('[data-order-list]'))return;event.preventDefault();target.classList.add('dragTarget');const rect=target.getBoundingClientRect(),before=event.clientY<rect.top+rect.height/2,targetList=target.parentElement;targetList.insertBefore(dragging,before?target:target.nextSibling)});
  document.addEventListener('dragleave',event=>event.target.closest('[data-order-item]')?.classList.remove('dragTarget'));
  document.querySelector('[data-order-form]')?.addEventListener('submit',syncAll);
  syncAll();
})();
