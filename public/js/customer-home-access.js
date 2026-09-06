'use strict';

(()=>{
  if(location.pathname!=='/account'&&location.pathname!=='/account/')return;

  // Home should start with the useful access summary rather than repeating a
  // large hero that says the same thing as the cards immediately below it.
  document.querySelector('.accountHero.simpleHero')?.remove();

  // Request content already has a dedicated navigation item, so do not repeat
  // the same journey as a large card on Home.
  for(const heading of document.querySelectorAll('.simpleServiceCard h2')){
    if(heading.textContent.trim()==="Want something that's missing?"){
      heading.closest('.simpleServiceCard')?.remove();
    }
  }

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
    .previousAccessSummary{
      margin:0 0 20px;
      padding:18px;
      border:1px solid var(--line);
      border-radius:12px;
      background:#0f171f;
    }
    .previousAccessHeading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
    .previousAccessHeading h2{margin:3px 0 0;font-size:19px}
    .previousAccessHeading p{margin:4px 0 0;color:var(--muted);font-size:11px;line-height:1.45}
    .previousAccessGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .previousAccessCard{display:flex;flex-direction:column;gap:8px;min-width:0;padding:15px;border:1px solid var(--line-soft);border-radius:10px;background:#111922}
    .previousAccessTop{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .previousAccessKind{color:#8593a4;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
    .previousAccessPlan{font-size:15px;overflow-wrap:anywhere}
    .previousAccessReason{margin:0;color:#c8aeb0;font-size:11px;line-height:1.45}
    .previousAccessEnded{color:var(--muted);font-size:10px}
    .previousAccessActions{display:grid;gap:7px;margin-top:auto;padding-top:4px}
    .previousAccessActions form{margin:0}
    .previousAccessActions .button{width:100%;box-sizing:border-box}
    @media(max-width:1100px){.previousAccessGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:760px){.previousAccessGrid{grid-template-columns:1fr}.previousAccessHeading{flex-direction:column}}
  `;
  document.head.append(style);

  const isInteractive=target=>Boolean(target?.closest?.('a,button,input,select,textarea,form,label,details,summary'));
  const openAccess=()=>location.assign('/account/access');
  const cards=[...document.querySelectorAll('.multiAccessSummary .accessSummaryCard')];

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

  const dateLabel=value=>{
    if(!value)return'';
    const date=new Date(value);
    if(Number.isNaN(date.getTime()))return'';
    return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric'}).format(date);
  };
  const selectorEscape=value=>window.CSS&&typeof window.CSS.escape==='function'?window.CSS.escape(String(value)):String(value).replace(/["\\]/g,'\\$&');
  const element=(tag,className,text)=>{
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!=null)node.textContent=text;
    return node;
  };
  const addPlanActions=(container,item)=>{
    if(item.paid&&item.planCode){
      const source=document.querySelector(`.planCard[data-plan-code="${selectorEscape(item.planCode)}"]`);
      const forms=source?[...source.querySelectorAll('.planActions form.checkoutForm')]:[];
      for(const sourceForm of forms){
        const form=sourceForm.cloneNode(true);
        form.querySelectorAll('input[name="discountCode"], [data-promo-target]').forEach(input=>input.remove());
        const button=form.querySelector('button');
        if(button){
          const provider=String(form.action||'').includes('/stripe')?'Stripe':String(form.action||'').includes('/paypal')?'PayPal':String(form.action||'').includes('/plisio')?'Plisio':'payment';
          button.textContent=`Re-subscribe with ${provider}`;
        }
        container.append(form);
      }
      if(forms.length)return;
    }
    const link=element('a','button secondary full',item.paid?'View this plan':'Open My Access');
    link.href=item.paid?'/account?skipRestore=1#plans':'/account/access';
    container.append(link);
  };

  const renderHistory=async()=>{
    try{
      const response=await fetch('/account/access-history.json',{credentials:'same-origin',headers:{Accept:'application/json'}});
      if(!response.ok)return;
      const payload=await response.json(),items=Array.isArray(payload?.items)?payload.items:[];
      if(!items.length||document.querySelector('.previousAccessSummary'))return;
      const anchor=document.querySelector('.multiAccessSummary');
      if(!anchor)return;

      const section=element('section','previousAccessSummary');
      section.setAttribute('aria-label','Past access');
      const heading=element('div','previousAccessHeading');
      const copy=document.createElement('div');
      copy.append(element('span','eyebrow','Past access'),element('h2','',`No longer active`),element('p','',`Plans you previously had, with the reason access ended.`));
      heading.append(copy);
      const count=element('span','pill',`${items.length} previous`);
      heading.append(count);
      section.append(heading);

      const grid=element('div','previousAccessGrid');
      for(const item of items){
        const card=element('article','previousAccessCard');
        const top=element('div','previousAccessTop');
        top.append(element('span','pill bad','Not active'),element('span','previousAccessKind',item.kind||'Plan'));
        card.append(top,element('strong','previousAccessPlan',item.planName||'Streaming access'),element('p','previousAccessReason',item.reason||'This plan is no longer active.'));
        const ended=dateLabel(item.endedAt);
        if(ended)card.append(element('div','previousAccessEnded',`Ended ${ended}`));
        const actions=element('div','previousAccessActions');
        addPlanActions(actions,item);
        card.append(actions);
        grid.append(card);
      }
      section.append(grid);
      anchor.insertAdjacentElement('afterend',section);
    }catch(_){/* History is an enhancement; Home remains usable if it cannot load. */}
  };

  renderHistory();
})();
