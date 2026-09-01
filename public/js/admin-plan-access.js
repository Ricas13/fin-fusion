'use strict';

(function(){
  const ICONS={
    product:'<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    commerce:'<path d="M12 2v20"/><path d="M17 6.2c-.9-1.3-2.5-2.1-4.5-2.1-2.8 0-4.5 1.4-4.5 3.5 0 5 9 2.3 9 7.3 0 2.2-1.9 3.7-4.9 3.7-2.1 0-4-.8-5.1-2.4"/>',
    availability:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    access:'<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
    delivery:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    libraries:'<path d="M3 7.5h7l2 2H21v9.5H3z"/><path d="M3 7.5V5h7l2 2.5"/>',
    lifecycle:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    requests:'<path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/>',
    summary:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 2v4M16 2v4M5 9h14"/><path d="M9 13h6M9 16h4"/>'
  };

  const baseline=new WeakMap();
  let saveController=null;

  function iconSvg(kind){
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]||ICONS.product}</svg>`;
  }

  /* Preserve the existing access-model behaviour exactly. */
  function accessEditor(){
    const form=document.querySelector('[data-plan-access-editor],#access form[action*="/editor-access"]');
    if(!form)return;
    const model=form.querySelector('[data-jellyfin-access-model]');
    const stream=form.querySelectorAll('[data-jellyfin-stream-fields]');
    const household=form.querySelectorAll('[data-jellyfin-household-fields]');

    function help(group,text){
      if(!group)return;
      let item=group.querySelector(':scope > .inlineHelp');
      if(!item){item=document.createElement('div');item.className='inlineHelp';group.appendChild(item);}
      item.textContent=text;
    }
    function sync(){
      const isHousehold=model?.value==='household_network';
      stream.forEach(el=>{el.hidden=false;});
      stream.forEach(el=>{
        const input=el.querySelector('input[name="streams"]');
        if(input)input.min='0';
        help(input?.closest('.formGroup'),'0 = unlimited. Maximum simultaneous playing sessions; independent of IP, registered-device and legacy household limits.');
      });
      household.forEach(el=>{el.hidden=!isHousehold;});
      if(model){
        const group=model.closest('.formGroup');
        const label=group?.querySelector('label');
        if(label)label.textContent='Legacy household lease';
        for(const option of model.options||[]){
          if(option.value==='concurrent_streams')option.textContent='Off';
          if(option.value==='household_network')option.textContent='Also enforce household network lease';
        }
        help(group,'Optional legacy network lease. Concurrent streams remain independently configurable above/below and the active-IP cap remains in Advanced Settings.');
      }
    }
    model?.addEventListener('change',sync);
    sync();
    window.addEventListener('load',sync,{once:true});
  }

  function cardKind(card){
    const id=String(card.id||'').toLowerCase();
    if(['product','commerce','availability','access','delivery','libraries','lifecycle','requests'].includes(id))return id;
    const title=String(card.querySelector('h2,h3')?.textContent||'').toLowerCase();
    if(title.includes('payment')||title.includes('commercial')||title.includes('price'))return'commerce';
    if(title.includes('availability')||title.includes('capacity'))return'availability';
    if(title.includes('access'))return'access';
    if(title.includes('delivery')||title.includes('server'))return'delivery';
    if(title.includes('librar'))return'libraries';
    if(title.includes('lifecycle')||title.includes('inactiv'))return'lifecycle';
    if(title.includes('request')||title.includes('jellyseerr'))return'requests';
    return'product';
  }

  function advancedDetails(card){
    return [...card.querySelectorAll('details.planCardDetails,details.adminSettingsAdvanced')];
  }

  function syncAdvancedButton(card){
    const button=card.querySelector(':scope > .planConfigHead .planReferenceAdvancedButton,:scope > .sectionHead .planReferenceAdvancedButton');
    if(!button)return;
    const details=advancedDetails(card);
    const expanded=details.some(item=>item.open);
    button.setAttribute('aria-expanded',expanded?'true':'false');
    button.disabled=!details.length;
  }

  function ensureAdvancedButton(card,actions){
    const details=advancedDetails(card);
    if(!details.length)return;
    let button=actions.querySelector('.planReferenceAdvancedButton');
    if(!button){
      button=document.createElement('button');
      button.type='button';
      button.className='planReferenceAdvancedButton';
      button.innerHTML='Advanced <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
      button.addEventListener('click',()=>{
        const items=advancedDetails(card);
        const shouldOpen=!items.some(item=>item.open);
        items.forEach(item=>{item.open=shouldOpen;});
        syncAdvancedButton(card);
      });
      actions.appendChild(button);
    }
    details.forEach(item=>{
      if(item.dataset.planReferenceToggleBound==='1')return;
      item.dataset.planReferenceToggleBound='1';
      item.addEventListener('toggle',()=>syncAdvancedButton(card));
    });
    syncAdvancedButton(card);
  }

  function decorateCard(card){
    const kind=cardKind(card);
    card.dataset.planReferenceKind=kind;
    const head=card.querySelector(':scope > .planConfigHead,:scope > .sectionHead');
    if(!head)return;

    let actions=head.querySelector(':scope > .planReferenceHeadActions');
    if(head.dataset.planReferenceDecorated!=='1'){
      head.dataset.planReferenceDecorated='1';
      const children=[...head.children];
      const titleBlock=children.find(child=>child.querySelector?.('h2,h3'))||children[0];
      if(titleBlock){
        const heading=document.createElement('div');
        heading.className='planReferenceHeading';
        const icon=document.createElement('span');
        icon.className='planReferenceTitleIcon';
        icon.innerHTML=iconSvg(kind);
        head.insertBefore(heading,titleBlock);
        heading.append(icon,titleBlock);
      }
      actions=document.createElement('div');
      actions.className='planReferenceHeadActions';
      [...head.children].forEach(child=>{
        if(child.classList.contains('planReferenceHeading')||child===actions)return;
        actions.appendChild(child);
      });
      head.appendChild(actions);
    }
    actions=actions||head.querySelector(':scope > .planReferenceHeadActions');
    if(actions)ensureAdvancedButton(card,actions);
  }

  function decorateCards(root){
    root.querySelectorAll('.planControlGrid > .planConfigCard,.planControlGrid > .requestPlanCard').forEach(decorateCard);
  }

  function decoratePage(root){
    const content=root.closest('.content')||document.querySelector('.content');
    if(!content)return null;
    content.classList.add('planReferencePage');

    const planName=String(root.querySelector('.planControlHeader .planControlIdentity strong')?.textContent||document.querySelector('.pageHeader h1')?.textContent||'Plan').trim();
    const pageHeader=document.querySelector('.pageHeader');
    if(pageHeader){
      const title=pageHeader.querySelector('h1');
      const titleContainer=title?.parentElement;
      if(titleContainer&&!titleContainer.querySelector('.planReferenceBreadcrumb')){
        const crumb=document.createElement('div');
        crumb.className='planReferenceBreadcrumb';
        crumb.innerHTML=`<span>Plans</span><b>/</b><strong></strong>`;
        crumb.querySelector('strong').textContent=planName;
        titleContainer.insertBefore(crumb,title);
      }
    }

    const identity=root.querySelector('.planControlHeader .planControlIdentity:first-child');
    if(identity&&!identity.querySelector('.planReferenceSummaryIcon')){
      const icon=document.createElement('span');
      icon.className='planReferenceSummaryIcon';
      icon.innerHTML=iconSvg('summary');
      identity.prepend(icon);
    }

    decorateCards(root);
    return content;
  }

  function planForms(root){
    return [...root.querySelectorAll('.planControlGrid form')].filter(form=>String(form.method||'get').toLowerCase()==='post'&&form.action);
  }

  function formState(form){
    const entries=[];
    for(const [key,value] of new FormData(form).entries()){
      if(key==='_csrf')continue;
      entries.push([key,typeof value==='string'?value:`[file:${value.name}:${value.size}]`]);
    }
    return JSON.stringify(entries);
  }

  function dirtyForms(root){
    return planForms(root).filter(form=>baseline.has(form)&&baseline.get(form)!==formState(form));
  }

  function installSaveController(root){
    if(saveController)return;
    const forms=planForms(root);
    if(!forms.length)return;
    forms.forEach(form=>baseline.set(form,formState(form)));

    const bar=document.createElement('div');
    bar.className='planReferenceSaveBar';
    bar.setAttribute('role','status');
    bar.setAttribute('aria-live','polite');
    bar.innerHTML=`<div class="planReferenceSaveStatus"><span class="planReferenceSaveStatusIcon">${iconSvg('lifecycle')}</span><div class="planReferenceSaveCopy"><strong>You have unsaved changes</strong><span data-plan-reference-save-message>Review your edits, then save them together.</span></div></div><div class="planReferenceSaveActions"><button class="planReferenceDiscard" type="button">Discard</button><button class="planReferenceSaveAll" type="button">Save changes</button></div>`;
    document.body.appendChild(bar);

    const topActions=document.querySelector('.topBarActions');
    let topSave=null;
    if(topActions&&!topActions.querySelector('.planReferenceTopSave')){
      topSave=document.createElement('button');
      topSave.type='button';
      topSave.className='button planReferenceTopSave';
      topSave.textContent='Save changes';
      topActions.appendChild(topSave);
    }else topSave=topActions?.querySelector('.planReferenceTopSave')||null;

    const discard=bar.querySelector('.planReferenceDiscard');
    const save=bar.querySelector('.planReferenceSaveAll');
    const message=bar.querySelector('[data-plan-reference-save-message]');
    let saving=false;

    function refresh(){
      const count=dirtyForms(root).length;
      bar.classList.toggle('isVisible',count>0);
      if(topSave)topSave.disabled=count===0||saving;
      if(!saving){
        save.disabled=count===0;
        discard.disabled=count===0;
        message.textContent=count===1?'1 section has unsaved changes.':`${count} sections have unsaved changes.`;
      }
      return count;
    }

    async function saveAll(){
      const changed=dirtyForms(root);
      if(!changed.length){refresh();return;}
      for(const form of changed){
        if(!form.reportValidity()){
          form.closest('.planConfigCard,.requestPlanCard')?.scrollIntoView({behavior:'smooth',block:'center'});
          return;
        }
      }
      saving=true;
      save.disabled=true;
      discard.disabled=true;
      if(topSave)topSave.disabled=true;
      message.textContent=`Saving ${changed.length} changed section${changed.length===1?'':'s'}…`;
      try{
        let finalUrl=location.href;
        for(const form of changed){
          const response=await fetch(form.action,{
            method:'POST',
            body:new FormData(form),
            credentials:'same-origin',
            redirect:'follow',
            headers:{'X-Requested-With':'XMLHttpRequest'}
          });
          if(!response.ok)throw new Error(`Save failed with HTTP ${response.status}.`);
          finalUrl=response.url||finalUrl;
          const destination=new URL(finalUrl,location.href);
          if(destination.searchParams.has('error')){
            location.assign(finalUrl);
            return;
          }
        }
        location.assign(finalUrl);
      }catch(error){
        saving=false;
        message.textContent=error?.message||'The changes could not be saved. Existing card save controls remain available.';
        save.disabled=false;
        discard.disabled=false;
        if(topSave)topSave.disabled=false;
      }
    }

    function discardAll(){location.reload();}

    root.addEventListener('input',refresh,true);
    root.addEventListener('change',refresh,true);
    save.addEventListener('click',saveAll);
    discard.addEventListener('click',discardAll);
    topSave?.addEventListener('click',saveAll);

    saveController={refresh,saveAll};
    refresh();
  }

  function boot(){
    accessEditor();
    const room=document.querySelector('.planControlRoom');
    if(!room)return;
    const content=decoratePage(room);
    if(!content)return;
    installSaveController(room);

    const observer=new MutationObserver(()=>{
      decorateCards(room);
      saveController?.refresh();
    });
    observer.observe(room,{childList:true,subtree:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
