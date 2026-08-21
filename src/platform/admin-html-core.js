'use strict';

// The stable base renderer owns the admin document chrome and the
// /css/admin-capability.css link. This wrapper only adds progressive behavior.
const base=require('./admin-html-core-base');

function commandPaletteMarkup(){
  return `<div class="adminCommandBackdrop" data-command-palette hidden><section class="adminCommandPalette" id="adminCommandPalette" role="dialog" aria-modal="true" aria-labelledby="adminCommandTitle"><div class="adminCommandPaletteHeader"><span class="adminCommandSearchIcon" aria-hidden="true">⌕</span><div><label class="srOnly" id="adminCommandTitle" for="adminCommandInput">Search or jump to an admin area</label><input class="adminCommandInput" id="adminCommandInput" data-command-input type="search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="adminCommandResults" placeholder="Search or jump to…"></div><button class="adminCommandClose" type="button" data-command-close aria-label="Close command palette">Esc</button></div><div class="adminCommandResults" id="adminCommandResults" data-command-results role="listbox" aria-label="Admin commands"></div><div class="adminCommandPaletteFooter"><span>Type a destination or search term</span><div class="adminCommandKeys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div></section></div>`;
}

function addCommandPalette(html){
  const quickFind=/<form class="adminQuickFind" method="get" action="\/admin\/search" role="search">[\s\S]*?<\/form>/;
  const launcher='<button class="adminQuickFind adminQuickFindLauncher" type="button" data-command-palette-open aria-haspopup="dialog" aria-controls="adminCommandPalette" aria-expanded="false"><span class="adminQuickFindPrompt">Search or jump to…</span><span class="adminCommandShortcut" data-command-shortcut aria-hidden="true">Ctrl K</span><span class="srOnly">Open command palette</span></button>';
  const withLauncher=quickFind.test(html)?html.replace(quickFind,launcher):html;
  return withLauncher.includes('</body>')?withLauncher.replace('</body>',`${commandPaletteMarkup()}</body>`):`${withLauncher}${commandPaletteMarkup()}`;
}

function layout(options={}){
  const html=addCommandPalette(base.layout(options));
  const scripts='<script src="/js/admin-setting-controls.js" defer></script><script src="/js/admin-customer-filters.js" defer></script><script src="/js/admin-safety-confirmations.js" defer></script><script src="/js/admin-command-palette.js" defer></script><script src="/js/admin-stremio-journey.js" defer></script>';
  return html.includes('</body>')?html.replace('</body>',`${scripts}</body>`):`${html}${scripts}`;
}

module.exports={...base,layout,commandPaletteMarkup,addCommandPalette};