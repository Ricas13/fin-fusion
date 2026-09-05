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
    if(value<60)return`${Math.floor(value)}s`;
    const minutes=Math.floor(value/60);
    if(minutes<60)return`${minutes}m`;
    const hours=Math.floor(minutes/60),rest=minutes%60;
    return `${hours}:${String(rest).padStart(2,'0')}`;
  }

  function streamRow(stream){
    const row=element('div','customerNowPlayingRow');
    const poster=element('div','customerNowPlayingPoster');
    poster.append(element('span','', '▶'));
    if(stream.imageUrl){
      const image=document.createElement('img');
      image.src=stream.imageUrl;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';
      image.addEventListener('error',()=>image.remove(),{once:true});
      poster.append(image);
    }
    row.append(poster);

    const copy=element('div','customerNowPlayingCopy');
    copy.append(element('strong','customerNowPlayingTitle',stream.title||'Playing media'));
    const detail=[stream.service,stream.device||stream.client,stream.paused?'Paused':null].filter(Boolean).join(' · ');
    copy.append(element('span','customerNowPlayingDetail',detail||'Streaming now'));
    copy.append(element('span','customerNowPlayingElapsed',elapsed(stream.positionSeconds)));
    row.append(copy);
    row.append(element('span','customerNowPlayingChevron','›'));
    return row;
  }

  function render(streams){
    const list=Array.isArray(streams)?streams:[];
    if(!list.length){root.hidden=true;root.replaceChildren();return;}
    const header=element('div','customerNowPlayingHeader');
    const heading=element('div','customerNowPlayingHeading');
    heading.append(element('span','customerNowPlayingPulse'));
    heading.append(element('strong','',`${list.length} live stream${list.length===1?'':'s'}`));
    header.append(heading);
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
      // Keep the most recent successful snapshot during a brief portal/database hiccup.
    }
  }

  refresh();
  timer=window.setInterval(refresh,15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  window.addEventListener('pagehide',()=>{if(timer)window.clearInterval(timer);},{once:true});
})();
