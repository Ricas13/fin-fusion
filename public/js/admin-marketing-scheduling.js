'use strict';

(() => {
  document.querySelectorAll('[data-marketing-schedule-form]').forEach(form => {
    form.addEventListener('submit', event => {
      const local=form.querySelector('[data-marketing-local-time]');
      const iso=form.querySelector('[data-marketing-scheduled-iso]');
      if(!local||!iso)return;
      const value=String(local.value||'').trim();
      const parsed=value?new Date(value):null;
      if(!parsed||Number.isNaN(parsed.getTime())){
        event.preventDefault();
        local.setCustomValidity('Choose a valid schedule date and time.');
        local.reportValidity();
        return;
      }
      local.setCustomValidity('');
      iso.value=parsed.toISOString();
    });
    const local=form.querySelector('[data-marketing-local-time]');
    local?.addEventListener('input',()=>local.setCustomValidity(''));
  });

  const campaignForm=document.querySelector('[data-marketing-campaign-form]');
  if(!campaignForm)return;
  const fields=[...campaignForm.querySelectorAll('[data-marketing-audience-field]')];
  const count=campaignForm.querySelector('[data-marketing-audience-count]');
  const status=campaignForm.querySelector('[data-marketing-audience-status]');
  let timer=null,requestSequence=0;

  async function refreshAudience(){
    const sequence=++requestSequence;
    const params=new URLSearchParams();
    fields.forEach(field=>{const value=String(field.value||'').trim();if(value)params.set(field.name,value);});
    if(status)status.textContent=' · checking current audience…';
    try{
      const response=await fetch(`/admin/marketing/audience-preview?${params.toString()}`,{headers:{Accept:'application/json'},credentials:'same-origin'});
      const data=await response.json().catch(()=>null);
      if(sequence!==requestSequence)return;
      if(!response.ok||!data?.ok)throw new Error(data?.error||'Audience preview failed');
      if(count)count.textContent=String(Number(data.count||0));
      if(status)status.textContent=' · current consent and subscription data';
    }catch(error){
      if(sequence!==requestSequence)return;
      if(status)status.textContent=` · ${String(error?.message||'preview unavailable').slice(0,120)}`;
    }
  }

  function schedulePreview(){clearTimeout(timer);timer=setTimeout(refreshAudience,250);}
  fields.forEach(field=>{field.addEventListener('change',schedulePreview);field.addEventListener('input',schedulePreview);});
})();
