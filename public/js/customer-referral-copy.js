'use strict';

document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-copy-referral-link]');
  if(!button)return;
  const input=document.getElementById('referral-signup-link');
  if(!input)return;
  const original=button.textContent;
  try{
    await navigator.clipboard.writeText(input.value);
    button.textContent='Copied';
  }catch(_){
    input.focus();
    input.select();
    try{
      document.execCommand('copy');
      button.textContent='Copied';
    }catch(__){
      button.textContent='Copy failed';
    }
  }
  window.setTimeout(()=>{button.textContent=original;},1500);
});
