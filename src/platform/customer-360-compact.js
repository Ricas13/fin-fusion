'use strict';

const base=require('./customer-360-access-cards');
const accessStatus=require('./customer-360-access-status');
const billing=require('./admin-customer-billing');
const {esc}=require('./admin-html');

function compactControl(detail,token,ctx,permanent){
  const customerId=detail.customer.id;
  let html=base.controlGrid(detail,token,ctx,permanent);
  const portalAction=new RegExp(`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/impersonate">[\\s\\S]*?<\\/form>`);
  html=html.replace(portalAction,'');
  html=html.replace('Everything an administrator can change for this customer, always visible.','Primary controls stay compact; rarely used actions are tucked away.');
  html=html.replace(/<article class="ctlCard ctlMore">[\s\S]*?<div class="ctlMoreList">([\s\S]*?)<\/div><\/article>/,
    '<details class="ctlCard ctlMore"><summary><span class="ctlNum">9</span><span class="ctlMoreTitle"><span class="ctlLabel">More</span><strong>Rarely used</strong></span><span class="ctlMoreChevron">▸</span></summary><div class="ctlMoreList">$1</div></details>');
  return html;
}

function collapsedAccess(html){
  if(!html)return'';
  let out=html.replace('<section class="section"><div class="sectionHead">','<details class="section accessWorkspace"><summary class="sectionHead">');
  out=out.replace('</div></div><div class="sectionBody">','</div><span class="accessWorkspaceChevron">▸</span></summary><div class="sectionBody accessWorkspaceBody">');
  out=out.replace(/<\/section>$/,'</details>');
  return out;
}

function collapsedProvisioning(detail){
  const runs=(detail.runs||[]).slice(0,50);
  const failed=runs.filter(run=>run.status==='failed').length;
  let inner=base.provisioningHistory(detail);
  inner=inner.replace(/^<section class="section"><div class="sectionHead"><div><h2>Provisioning history<\/h2><div class="muted">[\s\S]*?<\/div><\/div><\/div><div class="sectionBody">/,'<div class="provisioningDisclosureBody">');
  inner=inner.replace(/<\/section>$/,'</div>');
  return `<details class="provisioningDisclosure"><summary><span>Provisioning history</span><small>${esc(`${runs.length} event${runs.length===1?'':'s'}${failed?` · ${failed} failed`:''}`)}</small><span class="provisioningChevron">▸</span></summary>${inner}</details>`;
}

function compactStyles(){return `<style>
/* Customer control: keep the 3x3 layout, but make it genuinely dense. */
.customer360Core .ctlGrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:8px 0}
.customer360Core .ctlCard{position:relative;min-height:64px;padding:7px 8px 7px 29px;gap:2px;border-radius:8px}
.customer360Core .ctlNum{position:absolute;left:7px;top:7px;width:15px;height:15px;margin:0;font-size:8px}
.customer360Core .ctlLabel{font-size:.57rem;margin-bottom:1px;letter-spacing:.04em}
.customer360Core .ctlTop strong,.customer360Core .ctlMoreTitle strong{font-size:.78rem;line-height:1.15}
.customer360Core .ctlSub{font-size:.62rem;line-height:1.25;flex:0}
.customer360Core .ctlTop .pill{padding:2px 5px;font-size:8px}
.customer360Core .ctlActions{gap:4px;margin-top:3px}
.customer360Core .ctlActions .button,.customer360Core .ctlInlineForm .button{min-height:24px;padding:3px 6px;font-size:.62rem}
.customer360Core .ctlInlineForm{gap:4px}
.customer360Core .ctlInlineForm select{min-height:27px;padding:3px 6px;font-size:.66rem}
.customer360Core details.ctlMore{padding:0;min-height:48px}
.customer360Core details.ctlMore>summary{position:relative;display:flex;align-items:center;gap:7px;min-height:47px;padding:7px 8px 7px 29px;cursor:pointer;list-style:none}
.customer360Core details.ctlMore>summary::-webkit-details-marker{display:none}
.customer360Core .ctlMoreTitle{display:grid;gap:0}
.customer360Core .ctlMoreChevron{margin-left:auto;color:var(--muted);font-size:.68rem;transition:transform .12s ease}
.customer360Core details.ctlMore[open] .ctlMoreChevron{transform:rotate(90deg)}
.customer360Core .ctlMoreList{padding:0 8px 8px;gap:4px}
.customer360Core .ctlMoreList .button,.customer360Core .ctlMoreList summary.button{min-height:27px;padding:4px 7px;font-size:.65rem}

/* Access is one collapsed workspace. Once opened, its cards flow 3 across. */
.customer360Core details.accessWorkspace>summary{cursor:pointer;list-style:none}
.customer360Core details.accessWorkspace>summary::-webkit-details-marker{display:none}
.customer360Core .accessWorkspaceChevron{margin-left:auto;color:var(--muted);transition:transform .12s ease}
.customer360Core details.accessWorkspace[open] .accessWorkspaceChevron{transform:rotate(90deg)}
.customer360Core .accessWorkspaceBody{padding:12px}
.customer360Core .accessWorkspace .laneWrap{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;align-items:start;margin-bottom:14px}
.customer360Core .accessWorkspace .laneHead{grid-column:1/-1;margin:0 0 1px}
.customer360Core .accessWorkspace .twoCol,.customer360Core .accessWorkspace .colStack{display:contents!important}
.customer360Core .accessWorkspace details.panel{min-width:0;margin:0}
.customer360Core .accessWorkspace details.panel summary{min-height:42px}

/* Provisioning is intentionally de-emphasised and lives at the very bottom. */
.provisioningDisclosure{margin-top:10px;border-top:1px solid var(--border-soft);opacity:.78}
.provisioningDisclosure>summary{display:flex;align-items:center;gap:9px;padding:9px 3px;color:var(--muted);font-size:.72rem;font-weight:700;cursor:pointer;list-style:none}
.provisioningDisclosure>summary::-webkit-details-marker{display:none}
.provisioningDisclosure>summary small{margin-left:auto;font-size:.66rem;font-weight:500}
.provisioningChevron{transition:transform .12s ease}
.provisioningDisclosure[open]{opacity:1}
.provisioningDisclosure[open] .provisioningChevron{transform:rotate(90deg)}
.provisioningDisclosureBody{padding-top:4px}

/* The route historically appended legacy panels after the unified view. Keep them out of this focused page. */
.customer360Core~.section{display:none!important}
@media(max-width:900px){.customer360Core .ctlGrid,.customer360Core .accessWorkspace .laneWrap{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.customer360Core .ctlGrid,.customer360Core .accessWorkspace .laneWrap{grid-template-columns:1fr}}
</style>`;}

async function render(detail,token,options={}){
  if(!detail?.customer?.id)return'';
  const operatorContext=require('./admin-customer-operator').context;
  const ctx=await operatorContext(detail.customer.id,options.req).catch(()=>null);
  const manualPayments=await billing.manualPayments(detail.customer.id).catch(()=>[]);
  const withManual={...detail,manualPayments};
  const access=await base.accessLibrariesRequests(detail,token,options).catch(error=>`<section class="section"><div class="notice error">Access, libraries &amp; requests could not be loaded. ${esc(String(error?.message||'Try again.').slice(0,200))}</div></section>`);
  const core=`<div class="customer360Core" data-customer360-core>${compactControl(detail,token,ctx,options.permanent)}${accessStatus.render(detail,token)}${collapsedAccess(access)}${base.billingSection(withManual,token)}${base.activitySection(detail)}${collapsedProvisioning(detail)}</div>`;
  return `${base.styles()}${compactStyles()}${core}`;
}

module.exports={render,compactControl,collapsedAccess,collapsedProvisioning,compactStyles};
