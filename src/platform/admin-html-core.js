'use strict';

const branding=require('./branding');
const nav=require('./admin-nav');
const paymentWorkflow=require('./payment-workflow-tabs');

function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}

const iconPaths={
  dashboard:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
  people:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  servers:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  commerce:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h2"/>',
  automation:'<path d="M18 8a6 6 0 1 0 1.76 4.24"/><path d="M18 3v5h5"/><path d="m13 9-3 4h4l-3 4"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06-.06A1.7 1.7 0 0 0 19.4 9c.2.37.52.68.9.87.33.16.7.24 1.06.23H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>'
};

function icon(key){return `<span class="navIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[key]||iconPaths.dashboard}</svg></span>`}

const critical=`*{box-sizing:border-box}:root{--bg:#090d12;--sidebar:#0d1218;--panel:#121820;--border:#222b36;--text:#dfe6ed;--muted:#8390a0;--accent:#20a9d6;--good:#39d98a;--warn:#f7b955;--bad:#ff6174;--sidebar-w:248px}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}.appShell{min-height:100vh;background:var(--bg)}.adminHeader{position:fixed;inset:0 auto 0 0;width:var(--sidebar-w);z-index:110;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column}.headerMain{padding:18px 17px 15px}.brandBlock{display:flex;align-items:center;gap:11px;text-decoration:none}.brandLogo{width:34px;height:34px;border-radius:9px;object-fit:cover}.brandText{font-size:15px;font-weight:800;color:#f4f7fa}.brandSub{font-size:10px;color:#647184}.adminTabsWrap{flex:1;overflow:auto;padding:8px 10px 168px}.adminTabs{display:grid;gap:8px}.navSection{display:block}.navSection>summary{list-style:none}.navSection>summary::-webkit-details-marker{display:none}.navSectionLabel{display:flex;align-items:center;gap:3px;min-height:36px;padding:0 5px;color:#8290a1;font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;cursor:pointer;border-radius:8px}.navSectionLabel:hover{background:rgba(255,255,255,.03);color:#aab5c2}.navSectionHome{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:7px 3px;color:inherit;text-decoration:none;border-radius:6px}.navSectionHome:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.navIcon{width:15px;height:15px;display:grid;place-items:center}.navIcon svg{width:15px;height:15px}.navChevron{margin-left:auto;padding:8px 5px;font-size:13px;line-height:1;color:#526173;transform:rotate(-90deg);transition:transform .14s ease}.navSection[open] .navChevron{transform:rotate(0)}.navSectionPages{display:none;gap:2px;padding-top:3px}.navSection[open] .navSectionPages{display:grid}.adminTab{display:flex;align-items:center;min-height:34px;padding:7px 10px 7px 31px;border-radius:8px;color:#9aa6b5;text-decoration:none;font-weight:600;font-size:12px;transition:background .14s ease,color .14s ease,transform .14s ease}.adminTab:hover{color:#eef7fb;background:rgba(32,169,214,.07);transform:translateX(2px)}.adminTab.active{color:#fff;background:rgba(32,169,214,.12);box-shadow:inset 3px 0 0 var(--accent)}.headerActions{position:absolute;left:10px;right:10px;bottom:10px;display:grid;gap:2px;padding-top:9px;border-top:1px solid var(--border)}.headerActionLabel{padding:0 10px 4px;color:#586777;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.headerButton{display:flex;padding:6px 10px;color:#8e9aaa;text-decoration:none;font-size:11px;border-radius:7px}.headerButton:hover{background:rgba(255,255,255,.035);color:#dfe6ed}.mainPane{min-height:100vh;margin-left:var(--sidebar-w);background:var(--bg)}.topBar{position:sticky;top:0;z-index:95;height:58px;padding:0 30px;display:flex;align-items:center;justify-content:space-between;background:rgba(13,18,24,.96);border-bottom:1px solid var(--border)}.content{padding:30px 32px 56px}.pageHeader{margin-bottom:22px}.pageHeader h1{margin:0 0 6px;font-size:27px;line-height:1.15;color:#f4f7fa}.muted{color:var(--muted)}@media(max-width:860px){:root{--sidebar-w:0px}.adminHeader{position:static;width:100%;border-right:0;border-bottom:1px solid var(--border)}.adminTabsWrap{padding:6px 10px 10px;overflow-x:auto}.adminTabs{display:flex;min-width:max-content;gap:12px}.navSection{display:flex;align-items:center}.navSectionLabel{display:none}.navSectionPages,.navSection[open] .navSectionPages{display:flex;gap:4px;padding:0}.adminTab{padding:7px 10px}.headerActions{display:none}.mainPane{margin-left:0}.topBar{height:50px;padding:0 15px}.content{padding:20px 15px 40px}}`;

function activePage(active){
  const key=nav.activeKey(active);
  const group=nav.groupFor(key);
  const page=group.pages.find(item=>item[0]===key)||group.pages[0];
  return {key,sidebarKey:nav.sidebarKey(key),group,page};
}

function header(active,site){
  const current=activePage(active);
  const sections=nav.groups.map(group=>{
    const activeGroup=group.key===current.group.key;
    const pages=group.pages.map(([key,label,url])=>`<a class="adminTab ${current.sidebarKey===key?'active':''}" href="${esc(url)}" title="Open ${esc(label)}">${esc(label)}</a>`).join('');
    return `<details class="navSection ${activeGroup?'active':''}" data-nav-section="${esc(group.key)}" ${activeGroup?'open':''}><summary class="navSectionLabel"><a class="navSectionHome" href="${esc(nav.landingFor(group))}">${icon(group.key)}<span>${esc(group.label)}</span></a><span class="navChevron" aria-hidden="true">⌄</span></summary><div class="navSectionPages">${pages}</div></details>`;
  }).join('');
  return `<header class="adminHeader"><div class="headerMain"><a class="brandBlock" href="/admin"><img class="brandLogo" src="${esc(branding.assetUrl('logo'))}" alt=""><div><div class="brandText">${esc(site)}</div><div class="brandSub">Control centre</div></div></a></div><div class="adminTabsWrap"><nav class="adminTabs" aria-label="Administration">${sections}</nav></div><div class="headerActions"><div class="headerActionLabel">My account</div><a class="headerButton" href="/admin/profile">Profile</a><a class="headerButton" href="/admin/profile/notifications">Notifications</a><a class="headerButton" href="/admin/security">Security</a><a class="headerButton hideMobile" href="/" target="_blank" rel="noopener noreferrer">Open storefront</a><a class="headerButton danger" href="/logout">Sign out</a></div></header>`;
}

function paymentTabsFor(options){
  const title=String(options.title||'');
  if(!['Payments','Provider mappings','Billing'].includes(title))return'';
  const active=title==='Billing'?'billing':title==='Provider mappings'?'mappings':'setup';
  return paymentWorkflow.tabs(active);
}

function layout(options={}){
  const site=options.siteName||'CAPTAiNFiN';
  const current=activePage(options.active);
  const docsAction='<a class="topHelpLink" href="/help" target="_blank" rel="noopener noreferrer">Docs</a>';
  const topActions=`<div class="topBarActions">${docsAction}${options.action||''}</div>`;
  const quickFind='<form class="adminQuickFind" method="get" action="/admin/search" role="search"><input class="adminQuickFindInput" name="q" type="search" minlength="2" autocomplete="off" aria-label="Quick find customers, plans and servers" placeholder="Find customer, plan, server…"></form>';
  const favicon=`${branding.assetUrl('favicon')}?v=${Date.now()}`;
  const workflowTabs=paymentTabsFor(options);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(options.title)} · ${esc(site)}</title><link rel="icon" href="${esc(favicon)}"><style>${critical}</style><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><link rel="stylesheet" href="/css/customer-360.css"><link rel="stylesheet" href="/css/admin-server-library-dashboard.css"><link rel="stylesheet" href="/css/admin-form-feedback.css"><link rel="stylesheet" href="/css/admin-visual-refinement.css"><link rel="stylesheet" href="/css/operator-experience.css"></head><body><div class="appShell">${header(options.active,site)}<main class="mainPane"><header class="topBar"><div class="topBreadcrumb"><span>${esc(current.group.label)}</span><strong>${esc(current.page[1])}</strong></div>${quickFind}${topActions}</header><div class="content"><div class="pageHeader"><div><h1>${esc(options.title)}</h1><div class="pageSubtitle">${esc(options.subtitle||'')}</div></div></div>${workflowTabs}${options.body||''}</div></main></div><script src="/js/admin-form-feedback.js" defer></script><script src="/js/operator-experience.js" defer></script></body></html>`;
}

module.exports={esc,layout,header,paymentTabsFor};
