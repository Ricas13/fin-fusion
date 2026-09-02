'use strict';

(()=>{
  const root=document.querySelector('[data-customer-now-playing]');
  if(!root)return;
  let timer=null;

  function element(tag,className,text){
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!=null)node.textContent=String(text);
    return node;
  }

  function elapsed(seconds){
    const value=Number(seconds);
    if(!Number.isFinite(value)||value<10)return'just started';
    if(value<60)return`${Math.floor(value)}s into playback`;
    const minutes=Math.floor(value/60);
    if(minutes<60)return`${minutes}m into playback`;
    const hours=Math.floor(minutes/60),rest=minutes%60;
    return `${hours}h ${String(rest).padStart(2,'0')}m into playback`;
  }

  function streamRow(stream){
    const row=element('div','customerNowPlayingRow');
    const top=element('div','customerNowPlayingTop');
    const titleWrap=element('div','customerNowPlayingTitleWrap');
    titleWrap.append(element('span','customerNowPlayingType',String(stream.type||'Media').toUpperCase()));
    titleWrap.append(element('strong','customerNowPlayingTitle',stream.title||'Playing media'));
    top.append(titleWrap);

    const state=element('div','customerNowPlayingState');
    state.append(element('span','customerNowPlayingService',stream.service||'Jellyfin'));
    state.append(element('span',`pill ${stream.paused?'warn':'good'}`,stream.paused?'Paused':'Playing'));
    top.append(state);
    row.append(top);

    row.append(element('div','customerNowPlayingTrack'));
    const meta=element('div','customerNowPlayingMeta');
    const left=[stream.device,stream.client,stream.method].filter(Boolean).join(' · ');
    meta.append(element('span','',left||stream.service||'Streaming'));
    meta.append(element('span','',elapsed(stream.positionSeconds)));
    row.append(meta);
    return row;
  }

  function render(streams){
    const list=Array.isArray(streams)?streams:[];
    if(!list.length){root.hidden=true;root.replaceChildren();return;}
    const header=element('div','customerNowPlayingHeader');
    const heading=element('div','customerNowPlayingHeading');
    heading.append(element('span','customerNowPlayingPulse'));
    heading.append(element('strong','', 'Right now'));
    header.append(heading);
    header.append(element('span','customerNowPlayingCount',`${list.length} active`));
    const body=element('div','customerNowPlayingRows');
    list.forEach(stream=>body.append(streamRow(stream)));
    root.replaceChildren(header,body);
    root.hidden=false;
  }

  async function refresh(){
    if(document.hidden)return;
    try{
      const response=await fetch('/account/now-playing.json',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
      if(response.status===401){root.hidden=true;return;}
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();
      render(data.streams);
    }catch(_){
      // Keep the most recent successful snapshot rather than flashing the strip
      // away during a brief portal/database hiccup.
    }
  }

  refresh();
  timer=window.setInterval(refresh,15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  window.addEventListener('pagehide',()=>{if(timer)window.clearInterval(timer);},{once:true});
})();
