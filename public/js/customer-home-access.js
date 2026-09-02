'use strict';

(()=>{
  if(location.pathname!=='/account'&&location.pathname!=='/account/')return;

  const summary=document.querySelector('.multiAccessSummary');
  if(!summary)return;
  summary.setAttribute('role','link');
  summary.setAttribute('tabindex','0');
  summary.setAttribute('aria-label','Open My Access');
  summary.style.cursor='pointer';

  const isInteractive=target=>Boolean(target?.closest?.('a,button,input,select,textarea,form,label,details,summary'));
  summary.addEventListener('click',event=>{
    if(isInteractive(event.target))return;
    location.assign('/account/access');
  });
  summary.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    if(isInteractive(event.target)&&event.target!==summary)return;
    event.preventDefault();
    location.assign('/account/access');
  });
})();
