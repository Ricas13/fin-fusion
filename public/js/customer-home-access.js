'use strict';

(()=>{
  if(location.pathname!=='/account'&&location.pathname!=='/account/')return;

  // Request content already has a dedicated navigation item, so do not repeat
  // the same journey as a large card on Home.
  for(const heading of document.querySelectorAll('.simpleServiceCard h2')){
    if(heading.textContent.trim()==="Want something that's missing?"){
      heading.closest('.simpleServiceCard')?.remove();
    }
  }

  const cards=[...document.querySelectorAll('.multiAccessSummary .accessSummaryCard')];
  if(!cards.length)return;

  const style=document.createElement('style');
  style.textContent=`
    .accessSummaryCard.isAccessShortcut{
      cursor:pointer;
      position:relative;
      padding-bottom:46px;
      border-color:rgba(88,211,244,.28);
      transition:border-color .16s ease,background .16s ease,transform .16s ease,box-shadow .16s ease;
    }
    .accessSummaryCard.isAccessShortcut:hover,
    .accessSummaryCard.isAccessShortcut:focus-visible{
      border-color:rgba(88,211,244,.75);
      background:#16242d;
      transform:translateY(-1px);
      box-shadow:0 10px 26px rgba(0,0,0,.22);
      outline:none;
    }
    .accessSummaryCard.isAccessShortcut::after{
      content:'Open My Access  →';
      position:absolute;
      left:14px;
      right:14px;
      bottom:12px;
      min-height:26px;
      display:flex;
      align-items:center;
      justify-content:center;
      border:1px solid rgba(88,211,244,.38);
      border-radius:7px;
      background:rgba(21,146,185,.10);
      color:#c4f2ff;
      font-size:10px;
      font-weight:800;
      letter-spacing:.02em;
    }
    .accessSummaryCard.isAccessShortcut:hover::after,
    .accessSummaryCard.isAccessShortcut:focus-visible::after{
      border-color:rgba(88,211,244,.72);
      background:rgba(21,146,185,.18);
      color:#effbff;
    }
  `;
  document.head.append(style);

  const isInteractive=target=>Boolean(target?.closest?.('a,button,input,select,textarea,form,label,details,summary'));
  const openAccess=()=>location.assign('/account/access');

  for(const card of cards){
    card.classList.add('isAccessShortcut');
    card.setAttribute('role','link');
    card.setAttribute('tabindex','0');
    card.setAttribute('aria-label',`Open My Access for ${card.querySelector('.accessSummaryPlan')?.textContent.trim()||'this plan'}`);

    card.addEventListener('click',event=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      if(isInteractive(event.target))return;
      openAccess();
    });
    card.addEventListener('keydown',event=>{
      if(event.key!=='Enter'&&event.key!==' ')return;
      event.preventDefault();
      openAccess();
    });
  }
})();
