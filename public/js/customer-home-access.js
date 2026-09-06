'use strict';

(()=>{
  if(location.pathname!=='/account'&&location.pathname!=='/account/')return;

  // Keep the Home page stable: only the summary heading acts as a shortcut to
  // My Access. The previous implementation turned the entire active-access
  // section into a synthetic link, which could make normal Home navigation feel
  // like it immediately bounced back into /account/access.
  const shortcut=document.querySelector('.multiAccessSummary .multiAccessHeading');
  if(!shortcut)return;

  const isInteractive=target=>Boolean(target?.closest?.('a,button,input,select,textarea,form,label,details,summary'));
  shortcut.style.cursor='pointer';
  shortcut.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    if(isInteractive(event.target))return;
    location.assign('/account/access');
  });
})();
