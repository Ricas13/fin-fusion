'use strict';

// The stable base renderer owns the admin document chrome and the
// /css/admin-capability.css link. This wrapper adds progressive behavior and
// the server-owned navigation hierarchy shared by modern admin pages.
const base=require('./admin-html-core-base');
const contextNavigation=require('./admin-context-navigation');

function commandPaletteMarkup(){
  return `<div class="adminCommandBackdrop" data-command-palette hidden><section class="adminCommandPalette" id="adminCommandPalette" role="dialog" aria-modal="true" aria-labelledby="adminCommandTitle"><div class="adminCommandPaletteHeader"><span class="adminCommandSearchIcon" aria-hidden="true">⌕</span><div><label class="srOnly" id="adminCommandTitle" for="adminCommandInput">Search or jump to an admin area</label><input class="adminCommandInput" id="adminCommandInput" data-command-input type="search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="adminCommandResults" placeholder="Search or jump to…"></div><button class="adminCommandClose" type="button" data-command-close aria-label="Close command palette">Esc</button></div><div class="adminCommandResults" id="adminCommandResults" data-command-results role="listbox" aria-label="Admin commands"></div><div class="adminCommandPaletteFooter"><span>Type a destination or search term</span><div class="adminCommandKeys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div></section></div>`;
}

function addCommandPalette(html){
  const quickFind=/<form class="adminQuickFind" method="get" action="\/admin\/search" role="search">[\s\S]*?<\/form>/;
  const launcher='<button class="adminQuickFind adminQuickFindLauncher" type="button" data-command-palette-open aria-haspopup="dialog" aria-controls="adminCommandPalette" aria-expanded="false"><span class="adminQuickFindPrompt">Search or jump to…</span><span class="adminCommandShortcut" data-command-shortcut aria-hidden="true">Ctrl K</span><span class="srOnly">Open command palette</span></button>';
  const withLauncher=quickFind.test(html)?html.replace(quickFind,launcher):html;
  return withLauncher.includes('</body>')?withLauncher.replace('</body>',`${commandPaletteMarkup()}</body>`):`${withLauncher}${commandPaletteMarkup()}`;
}

function addFilterStyles(html){
  const link='<link rel="stylesheet" href="/css/admin-filter-bars.css">';
  return html.includes('</head>')?html.replace('</head>',`${link}</head>`):html;
}

function addServerContextNavigation(options={}){
  const body=String(options.body||'');
  const navigation=contextNavigation.render(options.active);
  return {...options,body:navigation?`${navigation}${body}`:body};
}

function replaceBreadcrumb(html,active){
  const breadcrumb=contextNavigation.breadcrumb(active);
  if(!breadcrumb)return html;
  return String(html).replace(
    /<div class="topBreadcrumb" aria-label="Current location">[\s\S]*?<\/div>/,
    `<div class="topBreadcrumb" aria-label="Current location">${breadcrumb}</div>`
  );
}

const REDUNDANT_WORKFLOW_LABELS=Object.freeze([
  'Plans and storefront control room',
  'Orders and growth control room',
  'Payments and billing control room'
]);
function removeRedundantWorkflowNavigation(html){
  let output=String(html||'');
  for(const label of REDUNDANT_WORKFLOW_LABELS){
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    output=output.replace(new RegExp(`<nav class="workflowCardGrid operatorTabs" aria-label="${escaped}">[\\s\\S]*?<\\/nav>`,'g'),'');
  }
  return output;
}

// Page-action placement contract -----------------------------------------
// Generic navigation/actions belong in the top-right page header. Overview
// heroes may still carry corrective actions, but must not repeat a destination
// already exposed by the page header. Keeping the rule in the shared renderer
// prevents individual pages from drifting back into duplicate Add/Import/etc.
function actionHrefs(action=''){
  const hrefs=new Set();
  const re=/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>/gi;
  let match;
  while((match=re.exec(String(action||''))))hrefs.add(match[2]);
  return hrefs;
}

function dedupeOverviewActions(body='',action=''){
  const hrefs=actionHrefs(action);
  if(!hrefs.size)return String(body||'');
  return String(body||'').replace(
    /<section\b[^>]*class=(["'])[^"']*\b(?:sectionGraphicHero|operatorHero)\b[^"']*\1[^>]*>[\s\S]*?<\/section>/gi,
    section=>section
      .replace(/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>[\s\S]*?<\/a>/gi,(anchor,_quote,href)=>hrefs.has(href)?'':anchor)
      .replace(/<div\s+class=(["'])(?:buttonRow|operatorHeroActions)\1>\s*<\/div>/gi,'')
  );
}

function layout(options={}){
  const withActions={...options,body:dedupeOverviewActions(options.body,options.action)};
  const normalized=addServerContextNavigation(withActions);
  const rendered=removeRedundantWorkflowNavigation(base.layout(normalized));
  const withBreadcrumb=replaceBreadcrumb(rendered,options.active);
  const html=addFilterStyles(addCommandPalette(withBreadcrumb));
  // admin-customer-filters.js remains after the shared enhancer for backward
  // asset compatibility. Once admin-filter-bars.js has transformed Customers,
  // the legacy controller finds no original filter grid and exits immediately.
  // admin-navigation-coherence.js is now fallback/enhancement only: modern
  // pages already contain their navigation in this server-rendered document.
  const scripts='<script src="/js/admin-setting-controls.js" defer></script><script src="/js/admin-filter-bars.js" defer></script><script src="/js/admin-customer-filters.js" defer></script><script src="/js/admin-safety-confirmations.js" defer></script><script src="/js/admin-command-palette.js" defer></script><script src="/js/admin-sidebar-nav.js" defer></script><script src="/js/admin-stremio-journey.js" defer></script><script src="/js/admin-release-status.js" defer></script><script src="/js/admin-form-accessibility.js" defer></script><script src="/js/admin-surface-semantics.js" defer></script><script src="/js/admin-server-control.js" defer></script><script src="/js/admin-navigation-coherence.js" defer></script>';
  return html.includes('</body>')?html.replace('</body>',`${scripts}</body>`):`${html}${scripts}`;
}

module.exports={...base,layout,commandPaletteMarkup,addCommandPalette,addFilterStyles,addServerContextNavigation,replaceBreadcrumb,removeRedundantWorkflowNavigation,actionHrefs,dedupeOverviewActions};
