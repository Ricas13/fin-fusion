'use strict';

(()=>{
  for(const form of document.querySelectorAll('[data-library-form]')){
    const boxes=()=>[...form.querySelectorAll('input[type="checkbox"][name="library"]')];
    const setAll=checked=>{for(const box of boxes())box.checked=checked;};
    form.querySelector('[data-library-all]')?.addEventListener('click',()=>setAll(true));
    form.querySelector('[data-library-none]')?.addEventListener('click',()=>setAll(false));
  }

  const subscriptionCards=[...document.querySelectorAll('.jellyfinCredentialGrid .jellyfinCredential')];
  const freeServerCard=subscriptionCards.find(card=>/^Free Server\s*·/i.test(card.querySelector('span')?.textContent.trim()||''));
  if(!freeServerCard)return;

  const grid=freeServerCard.closest('.jellyfinCredentialGrid');
  if(!grid||grid.parentElement.querySelector('.freeServerRulesNotice'))return;

  const style=document.createElement('style');
  style.textContent=`
    .freeServerRulesNotice{
      margin-top:14px;
      display:flex;
      gap:12px;
      align-items:flex-start;
      padding:14px 16px;
      border:1px solid rgba(245,179,66,.35);
      border-radius:10px;
      background:rgba(245,179,66,.07);
      color:#cbd5df;
    }
    .freeServerRulesNoticeIcon{
      flex:0 0 auto;
      width:24px;
      height:24px;
      display:grid;
      place-items:center;
      border-radius:999px;
      background:rgba(245,179,66,.13);
      color:#ffd27d;
      font-weight:900;
      font-size:13px;
    }
    .freeServerRulesNotice strong{
      display:block;
      margin:0 0 3px;
      color:#f2f6fa;
      font-size:13px;
    }
    .freeServerRulesNotice p{
      margin:0;
      color:#9eacb9;
      font-size:12px;
      line-height:1.5;
    }
  `;
  document.head.append(style);

  const notice=document.createElement('div');
  notice.className='freeServerRulesNotice';
  notice.setAttribute('role','note');
  notice.innerHTML=`
    <span class="freeServerRulesNoticeIcon" aria-hidden="true">!</span>
    <div>
      <strong>Free Server rules</strong>
      <p>Free Server places are reserved for active users. If you have no activity for 7 days and less than 30 minutes of playback, your Free Server access may be removed automatically to make room for another user.</p>
    </div>
  `;
  grid.insertAdjacentElement('afterend',notice);
})();
