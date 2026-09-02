'use strict';

(() => {
  const path=location.pathname;

  function replaceText(root,replacements){
    if(!root)return;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[];let node;
    while((node=walker.nextNode()))nodes.push(node);
    nodes.forEach(textNode=>{
      let value=textNode.nodeValue||'';
      for(const [from,to] of replacements)value=value.replaceAll(from,to);
      textNode.nodeValue=value;
    });
  }

  function wrapPriority(input,label='Advanced order'){
    if(!input||input.closest('.stremioOrderDetails'))return;
    const details=document.createElement('details');details.className='stremioOrderDetails';
    const summary=document.createElement('summary');summary.textContent=label;
    const help=document.createElement('small');help.textContent='Lower numbers are tried first.';
    input.parentNode.insertBefore(details,input);details.append(summary,input,help);
    input.setAttribute('aria-label',`${input.getAttribute('aria-label')||'Source'} fallback order`);
  }

  function polishSources(){
    if(path!=='/admin/servers/stremio')return;
    const title=document.querySelector('.pageHeader h1');if(title)title.textContent='Stremio sources';
    const subtitle=document.querySelector('.pageHeader .pageSubtitle');if(subtitle)subtitle.textContent='Choose the Jellyfin libraries Stremio can use, then connect them to plans.';

    const banner=document.querySelector('.capabilityPage > .statusBanner');
    if(banner){
      banner.className='stremioFlowOverview';
      banner.innerHTML='<div><strong>Choose where Stremio can find your library.</strong><span>CAPTAiNFiN Jellyfin servers can be included directly. External Jellyfin servers are optional fallbacks when you need them.</span></div><details><summary>How playback is delivered</summary><p>CAPTAiNFiN finds matching titles and returns the appropriate Jellyfin result to Stremio. Playback goes directly between Stremio and Jellyfin; video is not proxied through the CAPTAiNFiN portal. Stremio access remains unlimited by device and simultaneous stream, subject to each plan\'s household-connection allowance.</p></details>';
    }

    const statLabels={
      'Runtime':'Stremio service',
      'Managed sources':'CAPTAiNFiN servers',
      'External sources':'External fallbacks',
      'Libraries selected':'Libraries included',
      'Indexed items':'Titles ready'
    };
    document.querySelectorAll('.capabilityStatLabel').forEach(el=>{if(statLabels[el.textContent.trim()])el.textContent=statLabels[el.textContent.trim()];});
    document.querySelectorAll('.capabilityStatMeta').forEach(el=>{
      el.textContent=el.textContent.replace('indexed & ready','ready').replace('Local lookup index only','Available to Stremio search').replace('Across both source types','Across all included sources');
    });

    const maintenance=document.querySelector('form[action="/admin/servers/stremio/reindex-all"]');
    if(maintenance&&!maintenance.closest('.stremioAdvancedMaintenance')){
      const details=document.createElement('details');details.className='stremioAdvancedMaintenance';
      const summary=document.createElement('summary');summary.textContent='Advanced maintenance';
      maintenance.parentNode.insertBefore(details,maintenance);details.append(summary,maintenance);
      const button=maintenance.querySelector('button');if(button)button.textContent='Rebuild all library caches';
    }

    document.querySelectorAll('.capabilitySectionTitle').forEach(block=>{
      const heading=block.querySelector('h2'),copy=block.querySelector('p');if(!heading)return;
      if(heading.textContent.trim()==='Managed Jellyfin sources'){
        heading.textContent='CAPTAiNFiN Jellyfin servers';
        if(copy)copy.textContent='Include your existing Jellyfin servers and choose which libraries should appear in Stremio.';
      }
      if(heading.textContent.trim()==='External Jellyfin sources'){
        heading.textContent='External Jellyfin fallbacks';
        if(copy)copy.textContent='Optional Jellyfin servers used when a plan needs an additional playback source.';
      }
    });

    document.querySelectorAll('.capabilityTable th').forEach(th=>{
      const value=th.textContent.trim();
      if(value==='Index')th.textContent='Library status';
      if(value==='Stremio / priority')th.textContent='Included / order';
      if(value==='Portal customer')th.textContent='Customer';
      if(value==='Hidden Jellyfin user')th.textContent='Playback account';
      if(value==='Managed server')th.textContent='Jellyfin server';
    });

    document.querySelectorAll('.sourceIdentity small').forEach(el=>{
      const value=el.textContent;
      if(/hidden accounts?/i.test(value))el.textContent=value.replace(/hidden account/gi,'customer playback account');
      else if(/ · token /i.test(value))el.textContent=value.replace(/ · token .*$/i,' · dedicated playback account');
    });
    document.querySelectorAll('.capabilityTable .pill').forEach(el=>{
      const map={Indexing:'Preparing',Queued:'Waiting','Not indexed':'Not prepared',Failed:'Needs attention'};
      const value=el.textContent.trim();if(map[value])el.textContent=map[value];
    });
    document.querySelectorAll('.sourceInlineSettings .priorityInput').forEach(input=>wrapPriority(input));
    document.querySelectorAll('.capabilitySourceDisclosure>summary').forEach(summary=>{
      summary.textContent=summary.textContent.replace('Libraries, credential and index controls','Libraries & advanced connection settings').replace('Libraries, connection and index controls','Libraries & advanced connection settings');
    });
    document.querySelectorAll('button').forEach(button=>{
      const map={
        'Clear & rebuild this index':'Rebuild library cache',
        'Save libraries & re-index':'Save libraries & refresh'
      };
      const value=button.textContent.trim();if(map[value])button.textContent=map[value];
    });
  }

  function polishPlan(){
    const hero=document.querySelector('[data-plan-service="stremio"]');
    if(!hero)return;
    replaceText(hero,[['household IPs','household connections'],['household IP','household connection']]);
    const form=document.querySelector('.stremioPlanForm');
    replaceText(form,[['Household IPs','Household connections'],['IP replacement','Connection replacement'],['inactive IP','inactive connection'],['household leases','household connections']]);
    const householdInput=form?.querySelector('input[name="householdLimit"]');
    const householdHelp=householdInput?.closest('.formGroup')?.querySelector('.inlineHelp');
    if(householdHelp)householdHelp.textContent='Maximum number of different home or internet connections that may use this Stremio plan.';
    const replacement=form?.querySelector('select[name="replacementPolicy"]');
    if(replacement){
      const customer=replacement.querySelector('option[value="customer_cooldown"]');if(customer)customer.textContent='Customer can change connection after cooldown';
      const automatic=replacement.querySelector('option[value="auto_inactive"]');if(automatic)automatic.textContent='Automatically replace a connection that is no longer active';
    }

    const sources=document.querySelector('.stremioSourcesCard');
    if(sources){
      const heading=sources.querySelector('.sectionHead h3');if(heading)heading.textContent='Plan delivery';
      const copy=sources.querySelector('.sectionHead .muted');if(copy)copy.textContent='CAPTAiNFiN Jellyfin servers are included automatically. Select external fallbacks only when this plan needs an additional source.';
      const manage=sources.querySelector('.sectionHead a');if(manage)manage.textContent='Manage Stremio sources';
      const summary=sources.querySelector('.stremioSourceSummary');
      if(summary){
        const strong=summary.querySelector('strong'),muted=summary.querySelector('.muted');
        if(strong)strong.textContent=strong.textContent.replace('selected source ready','external fallback ready').replace('selected sources ready','external fallbacks ready').replace('No additional sources selected','No external fallbacks selected');
        if(muted)muted.textContent='External fallbacks are optional. Your included CAPTAiNFiN Jellyfin servers remain available automatically.';
      }
      replaceText(sources,[['indexed titles','titles ready'],['Index not ready','Library preparing']]);
      sources.querySelectorAll('.stremioSourcePriority').forEach(label=>{
        if(label.closest('.stremioOrderDetails'))return;
        const input=label.querySelector('input');const caption=label.querySelector('span');if(caption)caption.textContent='Fallback order';
        const details=document.createElement('details');details.className='stremioOrderDetails';
        const summaryNode=document.createElement('summary');summaryNode.textContent='Advanced order';
        label.parentNode.insertBefore(details,label);details.append(summaryNode,label);
        const help=document.createElement('small');help.textContent='Lower numbers are tried first.';details.appendChild(help);
        if(input)input.setAttribute('aria-label',`${input.getAttribute('aria-label')||'Source'} fallback order`);
      });
      const save=sources.querySelector('button[type="submit"]');if(save)save.textContent='Save delivery sources';
    }
  }

  function polishCustomer(){
    if(!/^\/admin\/users\/[0-9a-f-]+\/manage$/i.test(path))return;
    const section=document.querySelector('#stremio-installation');if(!section)return;
    const subtitle=section.querySelector('.sectionHead .muted');if(subtitle)subtitle.textContent='Private installation link and recent Stremio activity for this customer.';
    section.querySelectorAll('label').forEach(label=>{if(label.textContent.trim()==='Manifest / installation URL')label.textContent='Private installation link';});
    section.querySelectorAll('button,a').forEach(control=>{
      const value=control.textContent.trim();
      if(value==='Copy manifest URL')control.textContent='Copy installation link';
      if(value==='Rotate installation URL'||value==='Generate / rotate installation URL')control.textContent='Create a new installation link';
    });
    replaceText(section,[['Last manifest request','Last Stremio check'],['Last stream request','Last playback request'],['Internal Stremio account','Private playback account']]);
    const diagnostics=section.querySelector(':scope > .serverGrid');
    if(diagnostics&&!diagnostics.closest('.stremioCustomerDiagnostics')){
      const details=document.createElement('details');details.className='stremioCustomerDiagnostics';
      const summary=document.createElement('summary');summary.textContent='Technical diagnostics';
      diagnostics.parentNode.insertBefore(details,diagnostics);details.append(summary,diagnostics);
      const error=section.querySelector(':scope > .notice.error');if(error)details.appendChild(error);
    }
  }

  document.addEventListener('DOMContentLoaded',()=>{
    polishSources();
    polishPlan();
    polishCustomer();
  });
})();
