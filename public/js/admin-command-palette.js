'use strict';

(() => {
  const backdrop=document.querySelector('[data-command-palette]');
  const dialog=backdrop?.querySelector('[role="dialog"]');
  const input=backdrop?.querySelector('[data-command-input]');
  const results=backdrop?.querySelector('[data-command-results]');
  const trigger=document.querySelector('[data-command-palette-open]');
  const closeButton=backdrop?.querySelector('[data-command-close]');
  if(!backdrop||!dialog||!input||!results||!trigger)return;

  let commands=[];
  let visible=[];
  let activeIndex=0;
  let returnFocus=null;

  function normalize(value){return String(value||'').toLowerCase().replace(/\s+/g,' ').trim();}
  function cleanGroup(section){
    const label=section?.querySelector('.navSectionHome span:last-child')?.textContent||'';
    return String(label).trim()||'Navigation';
  }
  function addCommand(list,command){
    const href=String(command.href||'').trim();
    const label=String(command.label||'').trim();
    if(!href||!label)return;
    if(list.some(item=>item.href===href))return;
    list.push({...command,href,label,search:normalize(`${label} ${command.group||''} ${command.keywords||''} ${href}`)});
  }
  function discoverCommands(){
    const list=[];
    [
      {label:'Add customer',href:'/admin/users/new',group:'Customers',keywords:'new create invite'},
      {label:'Import Jellyfin users',href:'/admin/jellyfin-import',group:'Customers',keywords:'import existing accounts'},
      {label:'Add Jellyfin server',href:'/admin/servers/new',group:'Jellyfin',keywords:'new create server'},
      {label:'Needs Attention',href:'/admin/attention',group:'Dashboard',keywords:'alerts problems issues review'}
    ].forEach(command=>addCommand(list,command));

    document.querySelectorAll('a.adminTab[href],a.adminSubTab[href]').forEach(link=>{
      addCommand(list,{
        label:(link.textContent||'').trim(),
        href:link.getAttribute('href'),
        group:cleanGroup(link.closest('.navSection')),
        keywords:link.getAttribute('title')||''
      });
    });
    document.querySelectorAll('.headerActions a.headerButton[href]').forEach(link=>{
      const href=link.getAttribute('href')||'';
      if(!href||href==='/logout'||link.target==='_blank')return;
      addCommand(list,{label:(link.textContent||'').trim(),href,group:'My account'});
    });
    commands=list;
  }

  function score(command,query){
    if(!query)return 1;
    const label=normalize(command.label),group=normalize(command.group),search=command.search;
    if(label===query)return 100;
    if(label.startsWith(query))return 80;
    if(label.includes(query))return 60;
    if(group.startsWith(query))return 45;
    if(search.includes(query))return 25;
    const words=query.split(' ').filter(Boolean);
    if(words.length>1&&words.every(word=>search.includes(word)))return 20;
    return 0;
  }

  function searchCommand(raw){
    const value=String(raw||'').trim();
    if(value.length<2)return null;
    return {
      label:`Search all records for “${value}”`,
      href:`/admin/search?q=${encodeURIComponent(value)}`,
      group:'Global search',
      keywords:'customers plans servers billing',
      dynamic:true
    };
  }

  function optionId(index){return `admin-command-option-${index}`;}
  function setActive(index,{scroll=true}={}){
    if(!visible.length){activeIndex=0;input.removeAttribute('aria-activedescendant');return;}
    activeIndex=Math.max(0,Math.min(index,visible.length-1));
    results.querySelectorAll('[role="option"]').forEach((node,i)=>{
      const selected=i===activeIndex;
      node.setAttribute('aria-selected',selected?'true':'false');
      if(selected&&scroll)node.scrollIntoView({block:'nearest'});
    });
    input.setAttribute('aria-activedescendant',optionId(activeIndex));
  }

  function render(){
    const raw=input.value||'';
    const q=normalize(raw);
    const ranked=commands
      .map(command=>({command,score:score(command,q)}))
      .filter(item=>item.score>0)
      .sort((a,b)=>b.score-a.score||a.command.label.localeCompare(b.command.label))
      .slice(0,q?9:10)
      .map(item=>item.command);
    const global=searchCommand(raw);
    visible=global?[...ranked,global]:ranked;
    if(!visible.length){
      results.innerHTML='<div class="adminCommandEmpty">No matching shortcuts. Type at least two characters to search customers, plans, servers and billing.</div>';
      setActive(0,{scroll:false});
      return;
    }
    results.innerHTML=visible.map((command,index)=>`<button class="adminCommandOption" id="${optionId(index)}" type="button" role="option" aria-selected="${index===0?'true':'false'}" data-command-index="${index}"><span class="adminCommandOptionCopy"><span class="adminCommandOptionLabel"></span><span class="adminCommandOptionMeta"></span></span><span class="adminCommandOptionHint">${command.dynamic?'Search':'Open'}</span></button>`).join('');
    results.querySelectorAll('[data-command-index]').forEach((node,index)=>{
      const command=visible[index];
      node.querySelector('.adminCommandOptionLabel').textContent=command.label;
      node.querySelector('.adminCommandOptionMeta').textContent=command.group||'Navigation';
    });
    setActive(0,{scroll:false});
  }

  function go(command){
    if(!command?.href)return;
    window.location.assign(command.href);
  }
  function openPalette(){
    if(!commands.length)discoverCommands();
    returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;
    backdrop.hidden=false;
    trigger.setAttribute('aria-expanded','true');
    input.value='';
    render();
    window.requestAnimationFrame(()=>input.focus());
  }
  function closePalette(){
    if(backdrop.hidden)return;
    backdrop.hidden=true;
    trigger.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');
    const target=returnFocus?.isConnected?returnFocus:trigger;
    target?.focus?.();
  }
  function isTypingTarget(target){
    return target instanceof HTMLElement&&Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
  }

  trigger.addEventListener('click',openPalette);
  closeButton?.addEventListener('click',closePalette);
  input.addEventListener('input',render);
  results.addEventListener('mousemove',event=>{
    const option=event.target.closest?.('[data-command-index]');
    if(option)setActive(Number(option.dataset.commandIndex),{scroll:false});
  });
  results.addEventListener('click',event=>{
    const option=event.target.closest?.('[data-command-index]');
    if(option)go(visible[Number(option.dataset.commandIndex)]);
  });
  backdrop.addEventListener('mousedown',event=>{if(event.target===backdrop)closePalette();});

  document.addEventListener('keydown',event=>{
    const paletteShortcut=(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k';
    if(paletteShortcut){event.preventDefault();backdrop.hidden?openPalette():closePalette();return;}
    if(backdrop.hidden)return;
    if(event.key==='Escape'){event.preventDefault();closePalette();return;}
    if(event.key==='ArrowDown'){event.preventDefault();setActive((activeIndex+1)%Math.max(visible.length,1));return;}
    if(event.key==='ArrowUp'){event.preventDefault();setActive((activeIndex-1+Math.max(visible.length,1))%Math.max(visible.length,1));return;}
    if(event.key==='Enter'&&document.activeElement===input&&visible.length){event.preventDefault();go(visible[activeIndex]);return;}
    if(event.key==='Tab'){
      const focusable=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href]')].filter(node=>!node.closest('[hidden]'));
      if(!focusable.length)return;
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });

  const shortcut=trigger.querySelector('[data-command-shortcut]');
  if(shortcut)shortcut.textContent=/Mac|iPhone|iPad/i.test(navigator.platform||navigator.userAgent)?'⌘ K':'Ctrl K';
  discoverCommands();
})();
