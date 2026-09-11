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

  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function form(action,label,buttonClass='secondary'){
    return `<form class="plainForm" method="post" action="${esc(action)}"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="returnTo" value="access"><button class="button ${esc(buttonClass)}" type="submit">${esc(label)}</button></form>`;
  }
  function render(data){
    const manifestUrl=data?.manifestUrl||'';
    const installUrl=data?.installUrl||manifestUrl;
    const household=data?.household||null;
    const replacement=household?.replacementState||null;
    const actions=manifestUrl
      ? `<a class="button primary" href="${esc(installUrl)}">Install in Stremio</a>${form('/account/stremio/revoke','Revoke link','danger')}`
      : form('/account/stremio/install','Create installation link','primary');
    const householdPanel=household
      ? `<div class="panel" style="margin-bottom:12px"><strong>Household access</strong><div class="accessMeta">${esc(household.accessModel||'Unlimited streams · Unlimited devices · 1 household connection')}</div>${replacement?`<div class="accessMeta" style="margin-top:8px">${esc(replacement.message||'')}</div>${replacement.allowed?`<div style="margin-top:10px">${form('/account/stremio/reset-household','Use a different household connection','secondary')}</div>`:'<div style="margin-top:10px"><span class="button secondary" aria-disabled="true">Household change on cooldown</span></div>'}`:''}</div>`
      : '<div class="panel" style="margin-bottom:12px"><strong>Household access</strong><div class="accessMeta">Your household access is being prepared.</div></div>';
    const setup=manifestUrl
      ? `<div class="panel" style="margin-bottom:12px"><strong>Get started with Stremio</strong><ol class="featureList"><li><strong>1. Open Stremio.</strong> Use <a href="https://web.stremio.com" target="_blank" rel="noopener noreferrer">web.stremio.com</a> or the Stremio app.</li><li><strong>2. Create or sign in to a Stremio account.</strong></li><li><strong>3. Open Profile → Addons → Add addon.</strong></li><li><strong>4. Paste this private manifest/install URL and install it.</strong><div class="buttonRow" style="margin-top:8px;align-items:center"><button class="button secondary small" type="button" data-stremio-copy>Copy URL</button><div class="field" style="margin:0;flex:1"><input class="input" value="${esc(manifestUrl)}" readonly data-stremio-manifest aria-label="Private Stremio manifest URL"></div></div><div class="accessMeta" style="margin-top:8px">Keep this link private.</div></li></ol></div>`
      : '<div class="notice">Create your private installation link, then use the Install in Stremio button.</div>';

    stremio.className='jellyfinAccountCard stremioAccessCard sectionBlock simpleServiceCard';
    stremio.innerHTML=`<div class="sectionHead"><div><h2>Stremio</h2><p>Install your private Stremio access and manage its household connection directly from here.</p><div class="accessMeta">${esc(planLine.replace(/\s*·\s*private installation manifest\s*$/i,''))}</div></div><div class="buttonRow">${actions}</div></div>${!manifestUrl&&household?.status!=='active'?'<div class="notice">Access is being prepared.</div>':''}${householdPanel}${setup}`;

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
      stremio.innerHTML=`<div class="jellyfinAccountHead"><div><div class="jellyfinAccountTitle"><strong>Stremio</strong><span class="pill warn">Unavailable</span></div><div class="jellyfinPlanLine">${esc(planLine)}</div></div></div><div class="notice warn">${esc(error.message||'Your Stremio setup is temporarily unavailable. Try again shortly.')}</div>`;
    });
})();
