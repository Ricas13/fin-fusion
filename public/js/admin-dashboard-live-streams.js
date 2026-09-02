'use strict';

(()=>{
  const root=document.querySelector('[data-admin-live-streams]');
  if(!root)return;
  const list=root.querySelector('[data-live-stream-grid]'),count=root.querySelector('[data-live-stream-count]'),meta=root.querySelector('[data-live-stream-meta]'),errorBox=root.querySelector('[data-live-stream-error]');
  const csrf=root.dataset.csrfToken||'';
  let timer=null,busy=false,messageTarget=null;

  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
  function seconds(value){const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;}
  function duration(value){
    const total=seconds(value);if(total===null)return'—';const whole=Math.floor(total),h=Math.floor(whole/3600),m=Math.floor((whole%3600)/60),s=whole%60;
    return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;
  }
  function bitrate(value){const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;return n>=1000000?`${(n/1000000).toFixed(n>=10000000?1:2)} Mb/s`:`${Math.round(n/1000)} kb/s`;}
  function remaining(stream){const pos=seconds(stream.positionSeconds),total=seconds(stream.durationSeconds);if(pos===null||total===null||total<=pos)return null;return `-${duration(total-pos)}`;}
  function typeLabel(stream){const type=String(stream.type||'Media').toLowerCase();if(type==='episode')return'EPISODE';if(type==='movie')return'MOVIE';if(type.includes('audio'))return'AUDIO';if(type.includes('livetv')||type==='tvchannel')return'LIVE TV';return String(stream.type||'MEDIA').toUpperCase();}
  function badge(text,kind=''){const span=el('span',`adminLiveStreamBadge${kind?` ${kind}`:''}`,text);return span;}
  function showError(message){errorBox.textContent=message||'';errorBox.hidden=!message;}
  function button(label,title,kind,handler){const b=el('button',`adminLiveStreamAction ${kind||''}`,label);b.type='button';b.title=title;b.setAttribute('aria-label',title);b.addEventListener('click',handler);return b;}

  function messageDialog(){
    let dialog=document.querySelector('[data-live-message-dialog]');if(dialog)return dialog;
    dialog=el('dialog','adminLiveMessageDialog');dialog.dataset.liveMessageDialog='';
    const form=el('form','adminLiveMessageForm');form.method='dialog';
    const top=el('div','adminLiveMessageTitle');top.append(el('div','', 'Send message'),button('×','Close message','close',()=>dialog.close()));form.append(top);
    const target=el('div','adminLiveMessageTarget');target.dataset.liveMessageTarget='';form.append(target);
    const titleLabel=el('label','adminLiveMessageField');titleLabel.append(el('span','', 'Title'));const title=el('input','input');title.name='header';title.maxLength=80;title.value='Message from administrator';titleLabel.append(title);form.append(titleLabel);
    const textLabel=el('label','adminLiveMessageField');textLabel.append(el('span','', 'Message'));const text=el('textarea','input');text.name='text';text.maxLength=500;text.rows=4;text.required=true;textLabel.append(text);form.append(textLabel);
    const timeoutLabel=el('label','adminLiveMessageField adminLiveMessageField--compact');timeoutLabel.append(el('span','', 'Show for'));const timeout=el('select','input');timeout.name='timeoutSeconds';[5,8,10,15,20,30].forEach(value=>{const option=el('option','',`${value} seconds`);option.value=String(value);if(value===8)option.selected=true;timeout.append(option);});timeoutLabel.append(timeout);form.append(timeoutLabel);
    const actions=el('div','adminLiveMessageButtons');const cancel=el('button','button secondary','Cancel');cancel.type='button';cancel.addEventListener('click',()=>dialog.close());const send=el('button','button','Send to stream');send.type='submit';actions.append(cancel,send);form.append(actions);
    form.addEventListener('submit',async event=>{event.preventDefault();if(!messageTarget)return;send.disabled=true;showError('');try{await post(messageTarget,'message',{header:title.value,text:text.value,timeoutSeconds:Number(timeout.value)});dialog.close();showNotice('Message sent.');}catch(error){showError(error.message);}finally{send.disabled=false;}});
    dialog.append(form);document.body.append(dialog);return dialog;
  }
  function openMessage(stream){messageTarget=stream;const dialog=messageDialog();dialog.querySelector('[data-live-message-target]').textContent=`${stream.user} · ${stream.title}`;dialog.querySelector('textarea[name="text"]').value='';dialog.showModal();dialog.querySelector('textarea[name="text"]').focus();}

  function showNotice(message){meta.textContent=message;window.setTimeout(()=>{if(meta.textContent===message)meta.textContent='Across enabled Jellyfin and Emby servers';},3000);}
  async function post(stream,kind,body){
    const url=`/admin/live-streams/server/${encodeURIComponent(stream.serverId)}/session/${encodeURIComponent(stream.sessionId)}/${kind}`;
    const response=await fetch(url,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,Accept:'application/json'},body:JSON.stringify(body)});
    let payload={};try{payload=await response.json();}catch(_){}
    if(!response.ok)throw new Error(payload.error||`Stream ${kind} failed.`);return payload;
  }
  async function control(stream,action,buttonNode){
    if(action==='stop'&&!window.confirm(`Stop ${stream.user}'s playback of ${stream.title}? If the client ignores Stop, CAPTAiNFiN may safely sign out that device when no other active stream shares it.`))return;
    buttonNode.disabled=true;showError('');try{await post(stream,'control',{action});showNotice(action==='stop'?'Stream stopped.':action==='pause'?'Pause command sent.':'Resume command sent.');window.setTimeout(refresh,500);}catch(error){showError(error.message);}finally{buttonNode.disabled=false;}
  }

  function streamRow(stream){
    const row=el('article','adminLiveStreamRow');
    if(stream.paused)row.classList.add('paused');if(String(stream.method).toLowerCase().includes('transcode'))row.classList.add('transcoding');

    const top=el('div','adminLiveStreamTop');
    const headline=el('div','adminLiveStreamHeadline');headline.append(badge(typeLabel(stream),'type'));
    const media=el('div','adminLiveStreamMedia');media.append(el('strong','adminLiveStreamTitle',stream.title||'Playing media'));if(stream.subtitle)media.append(el('span','adminLiveStreamSubtitle',stream.subtitle));headline.append(media);top.append(headline);

    const right=el('div','adminLiveStreamTopRight');
    const quick=el('div','adminLiveStreamQuick');quick.append(badge(stream.service||'Jellyfin','service'),badge(stream.paused?'Paused':'Playing',stream.paused?'paused':'playing'));if(stream.resolution)quick.append(badge(stream.resolution,'quality'));right.append(quick);
    const controls=el('div','adminLiveStreamActions');
    const pauseLabel=stream.paused?'▶':'Ⅱ',pauseTitle=stream.paused?'Resume stream':'Pause stream',pauseAction=stream.paused?'resume':'pause';const pauseButton=button(pauseLabel,pauseTitle,'pause',()=>control(stream,pauseAction,pauseButton));pauseButton.disabled=!stream.supportsControl;
    controls.append(pauseButton,button('✉','Send custom message','message',()=>openMessage(stream)));const stopButton=button('×','Stop stream','stop',()=>control(stream,'stop',stopButton));controls.append(stopButton);right.append(controls);top.append(right);row.append(top);

    const progress=el('div','adminLiveStreamProgress');const fill=el('i','');const pct=Number(stream.progressPercent);fill.style.width=`${Number.isFinite(pct)?Math.max(0,Math.min(100,pct)):0}%`;progress.append(fill);row.append(progress);

    const bottom=el('div','adminLiveStreamBottom');
    const identity=el('div','adminLiveStreamIdentity');const user=el('a','adminLiveStreamUser',stream.user||'Customer');user.href=`/admin/users/${encodeURIComponent(stream.customerId)}`;user.title=stream.email||stream.user||'Customer';identity.append(user);
    [stream.serverName,stream.device||stream.client,stream.remoteAddress,stream.isLocal?'local':'remote'].filter(Boolean).forEach(value=>{identity.append(el('span','adminLiveStreamDot','·'));identity.append(el('span','',value));});bottom.append(identity);

    const detail=el('div','adminLiveStreamDetail');
    [stream.method,bitrate(stream.bitrate),stream.videoCodec,stream.audioCodec&&stream.audioChannels?`${stream.audioCodec} ${stream.audioChannels}ch`:stream.audioCodec].filter(Boolean).forEach(value=>detail.append(el('span','',value)));
    const timing=el('span','adminLiveStreamTiming',`${duration(stream.positionSeconds)} / ${stream.durationSeconds!=null?duration(stream.durationSeconds):'Live'}${remaining(stream)?` · ${remaining(stream)} left`:''}`);detail.append(timing);bottom.append(detail);row.append(bottom);

    if(Array.isArray(stream.transcodeReasons)&&stream.transcodeReasons.length){const reasons=el('div','adminLiveStreamReasons',`Transcode: ${stream.transcodeReasons.join(', ')}`);reasons.title=reasons.textContent;row.append(reasons);}
    return row;
  }

  function render(payload){
    const streams=Array.isArray(payload?.streams)?payload.streams:[],failures=Array.isArray(payload?.failures)?payload.failures:[];count.textContent=`${streams.length} stream${streams.length===1?'':'s'}`;
    meta.textContent=failures.length?`${failures.length} server${failures.length===1?'':'s'} unavailable · showing confirmed live sessions`:'Across enabled Jellyfin and Emby servers';
    list.replaceChildren();if(!streams.length){const empty=el('div','adminLiveStreamsEmpty');empty.append(el('strong','',failures.length?'No confirmed streams available':'Nobody is streaming right now'));empty.append(el('span','',failures.length?'One or more media servers could not be checked.':'This panel will populate automatically when playback starts.'));list.append(empty);return;}
    streams.forEach(stream=>list.append(streamRow(stream)));
  }

  async function refresh(){
    if(busy||document.hidden)return;busy=true;
    try{const response=await fetch('/admin/live-streams',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`Live stream refresh failed (${response.status}).`);render(await response.json());showError('');}
    catch(error){showError(error.message||'Live streams could not be refreshed.');}
    finally{busy=false;}
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});refresh();timer=window.setInterval(refresh,10000);window.addEventListener('pagehide',()=>window.clearInterval(timer),{once:true});
})();
