'use strict';

(()=>{
  for(const form of document.querySelectorAll('[data-library-form]')){
    const boxes=()=>[...form.querySelectorAll('input[type="checkbox"][name="library"]')];
    const setAll=checked=>{for(const box of boxes())box.checked=checked;};
    form.querySelector('[data-library-all]')?.addEventListener('click',()=>setAll(true));
    form.querySelector('[data-library-none]')?.addEventListener('click',()=>setAll(false));
  }

  const stremio=document.querySelector('[data-stremio-access]');
  if(!stremio)return;
  const csrfToken=stremio.querySelector('input[name="_csrf"]')?.value||document.querySelector('input[name="_csrf"]')?.value||'';
  const planLine=stremio.querySelector('.jellyfinPlanLine')?.textContent?.trim()||'Private Stremio access';
  let trialTimer=null;

  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function form(action,label,buttonClass='secondary'){
    return `<form class="plainForm stremioInlineForm" style="display:inline-flex;margin:0;width:auto" method="post" action="${esc(action)}"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="returnTo" value="access"><button class="button ${esc(buttonClass)}" style="white-space:nowrap" type="submit">${esc(label)}</button></form>`;
  }
  function trialBanner(trial){
    if(!trial?.startsAt||!trial?.endsAt)return'';
    return `<div class="stremioTrialCountdown" style="position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:13px 18px 15px;border-bottom:1px solid var(--line-soft);background:linear-gradient(90deg,rgba(32,169,214,.12),rgba(53,201,135,.06))" data-stremio-trial-start="${esc(trial.startsAt)}" data-stremio-trial-end="${esc(trial.endsAt)}"><div class="stremioTrialCopy"><span class="eyebrow">Trial access</span><strong style="display:block;margin-top:2px">Your Stremio trial is active</strong><small style="display:block;margin-top:3px;color:var(--muted)" data-stremio-trial-range></small></div><div class="stremioTrialRemaining" style="text-align:right"><span style="display:block;color:var(--muted);font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em">Time remaining</span><strong style="display:block;margin-top:3px;font-size:17px" data-stremio-trial-remaining>Calculating…</strong></div><div class="stremioTrialProgress" style="position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.05);overflow:hidden" aria-hidden="true"><span style="display:block;height:100%;width:0;background:currentColor;color:#35c987;transition:width .5s linear" data-stremio-trial-progress></span></div></div>`;
  }
  function startTrialCountdown(){
    if(trialTimer){window.clearInterval(trialTimer);trialTimer=null;}
    const node=stremio.querySelector('[data-stremio-trial-start][data-stremio-trial-end]');
    if(!node)return;
    const startMs=new Date(node.dataset.stremioTrialStart||'').getTime();
    const endMs=new Date(node.dataset.stremioTrialEnd||'').getTime();
    if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs){node.remove();return;}
    const remainingNode=node.querySelector('[data-stremio-trial-remaining]');
    const progressNode=node.querySelector('[data-stremio-trial-progress]');
    const rangeNode=node.querySelector('[data-stremio-trial-range]');
    const fmt=value=>new Date(value).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    if(rangeNode)rangeNode.textContent=`${fmt(startMs)} → ${fmt(endMs)}`;
    const update=()=>{
      const now=Date.now(),remaining=Math.max(0,endMs-now),total=endMs-startMs,elapsed=Math.min(total,Math.max(0,now-startMs));
      const days=Math.floor(remaining/86400000),hours=Math.floor((remaining%86400000)/3600000),minutes=Math.floor((remaining%3600000)/60000),seconds=Math.floor((remaining%60000)/1000);
      if(remainingNode)remainingNode.textContent=remaining<=0?'Trial ended':`${days?`${days}d `:''}${hours}h ${minutes}m ${seconds}s`;
      if(progressNode)progressNode.style.width=`${Math.max(0,Math.min(100,(elapsed/total)*100))}%`;
      if(remaining<=0&&trialTimer){window.clearInterval(trialTimer);trialTimer=null;}
    };
    update();
    if(Date.now()<endMs)trialTimer=window.setInterval(update,1000);
  }
  function render(data){
    const manifestUrl=data?.manifestUrl||'';
    const installUrl=data?.installUrl||manifestUrl;
    const household=data?.household||null;
    const replacement=household?.replacementState||null;
    const lease=household?.currentLease||null;
    const actions=manifestUrl
      ? `<a class="button primary" style="width:auto;white-space:nowrap" href="${esc(installUrl)}">Install in Stremio</a>${form('/account/stremio/revoke','Revoke link','danger')}`
      : form('/account/stremio/install','Create installation link','primary');
    const leaseLabel=lease?.address||((Number(lease?.activeCount)||0)>0?'Registered household connection':'Not registered yet');
    const leaseNote=lease?.address?'This browser is currently using the registered household connection.':((Number(lease?.activeCount)||0)>0?'Open My Access from the registered household connection to reveal its public IP.':'Your first Stremio playback will register the household connection.');
    const householdPanel=household
      ? `<div class="panel" style="margin-bottom:12px"><strong>Household access</strong><div class="accessMeta">${esc(household.accessModel||'Unlimited streams · Unlimited devices · 1 household connection')}</div><div class="stremioLeaseLine" style="margin-top:10px;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap"><span style="color:var(--muted)">Current leased IP:</span><strong>${esc(leaseLabel)}</strong><small style="width:100%;color:var(--muted);font-size:9px">${esc(leaseNote)}</small></div>${replacement?`<div class="accessMeta" style="margin-top:8px">${esc(replacement.message||'')}</div>${replacement.allowed?`<div style="margin-top:10px">${form('/account/stremio/reset-household','Use a different household connection','secondary')}</div>`:'<div style="margin-top:10px"><span class="button secondary" aria-disabled="true">Household change on cooldown</span></div>'}`:''}</div>`
      : '<div class="panel" style="margin-bottom:12px"><strong>Household access</strong><div class="accessMeta">Your household access is being prepared.</div></div>';
    const setup=manifestUrl
      ? `<div class="panel" style="margin-bottom:12px"><strong>Get started with Stremio</strong><ol class="featureList"><li><strong>1. Open Stremio.</strong> Use <a href="https://web.stremio.com" target="_blank" rel="noopener noreferrer">web.stremio.com</a> or the Stremio app.</li><li><strong>2. Create or sign in to a Stremio account.</strong></li><li><strong>3. Open Profile → Addons → Add addon.</strong></li><li><strong>4. Paste this private manifest/install URL and install it.</strong><div class="buttonRow" style="margin-top:8px;align-items:center"><button class="button secondary small" type="button" data-stremio-copy>Copy URL</button><div class="field" style="margin:0;flex:1"><input class="input" value="${esc(manifestUrl)}" readonly data-stremio-manifest aria-label="Private Stremio manifest URL"></div></div><div class="accessMeta" style="margin-top:8px">Keep this link private.</div></li></ol></div>`
      : '<div class="notice">Create your private installation link, then use the Install in Stremio button.</div>';

    stremio.className='jellyfinAccountCard stremioAccessCard sectionBlock simpleServiceCard';
    stremio.innerHTML=`${trialBanner(data?.trial)}<div class="sectionHead"><div><h2>Stremio</h2><p>Install your private Stremio access and manage its household connection directly from here.</p><div class="accessMeta">${esc(planLine.replace(/\s*·\s*private installation manifest\s*$/i,''))}</div></div><div class="stremioHeadActions" style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;justify-content:flex-end;width:auto">${actions}</div></div>${!manifestUrl&&household?.status!=='active'?'<div class="notice">Access is being prepared.</div>':''}${householdPanel}${setup}`;

    startTrialCountdown();
    const copy=stremio.querySelector('[data-stremio-copy]');
    const manifest=stremio.querySelector('[data-stremio-manifest]');
    copy?.addEventListener('click',async()=>{
      if(!manifest?.value)return;
      try{
        await navigator.clipboard.writeText(manifest.value);
        const previous=copy.textContent;
        copy.textContent='Copied';
        window.setTimeout(()=>{copy.textContent=previous;},1200);
      }catch(_){
        manifest.focus();
        manifest.select();
      }
    });
  }

  fetch('/account/stremio/installation.json',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'})
    .then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Stremio installation link could not be loaded.');return data;})
    .then(render)
    .catch(error=>{
      if(trialTimer){window.clearInterval(trialTimer);trialTimer=null;}
      stremio.innerHTML=`<div class="jellyfinAccountHead"><div><div class="jellyfinAccountTitle"><strong>Stremio</strong><span class="pill warn">Unavailable</span></div><div class="jellyfinPlanLine">${esc(planLine)}</div></div></div><div class="notice warn">${esc(error.message||'Your Stremio setup is temporarily unavailable. Try again shortly.')}</div>`;
    });
})();
