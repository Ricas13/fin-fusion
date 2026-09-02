'use strict';

// Shared GitBook-style rendering engine for the admin and end-user
// documentation sections. Content comes from the repo's own docs/guide/
// GitBook source (see docs-guide-source.js), which already covers the
// deliberately small markdown subset used here — headings, paragraphs,
// bold/italic/code, links, lists, blockquote callouts and fenced code
// blocks — parsed by renderMarkdown below. Each doc section renders as a
// fully standalone HTML document (its own shell, not threaded through
// admin-html's operational layout pipeline) so the reading experience
// stays focused while signed-in customer docs can still reuse the account shell.

function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}

function inline(text){
  let out=esc(text);
  out=out.replace(/`([^`]+)`/g,'<code>$1</code>');
  out=out.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  out=out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g,'<em>$1</em>');
  out=out.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_match,label,url)=>{
    const safe=/^https?:\/\//.test(url)||url.startsWith('/')?url:'#';
    return `<a href="${esc(safe)}">${label}</a>`;
  });
  return out;
}

function renderProseBlocks(source){
  const blocks=String(source||'').trim().split(/\n{2,}/);
  return blocks.map(block=>{
    const lines=block.split('\n').map(l=>l.trim()).filter(Boolean);
    if(!lines.length)return'';
    if(lines[0].startsWith('### '))return`<h3>${inline(lines[0].slice(4))}</h3>`;
    if(lines[0].startsWith('## '))return`<h2>${inline(lines[0].slice(3))}</h2>`;
    if(lines.every(l=>l.startsWith('> ')))return`<blockquote>${lines.map(l=>`<p>${inline(l.slice(2))}</p>`).join('')}</blockquote>`;
    if(lines.every(l=>l.startsWith('- ')))return`<ul>${lines.map(l=>`<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    if(lines.every(l=>/^\d+\.\s/.test(l)))return`<ol>${lines.map(l=>`<li>${inline(l.replace(/^\d+\.\s/,''))}</li>`).join('')}</ol>`;
    return`<p>${lines.map(inline).join(' ')}</p>`;
  }).join('');
}

function renderMarkdown(source){
  const text=String(source||'').trim();
  const fence=/```[a-z0-9]*\n([\s\S]*?)```/g;
  let cursor=0,html='',match;
  while((match=fence.exec(text))){
    html+=renderProseBlocks(text.slice(cursor,match.index));
    html+=`<pre><code>${esc(match[1].replace(/\n$/,''))}</code></pre>`;
    cursor=fence.lastIndex;
  }
  html+=renderProseBlocks(text.slice(cursor));
  return html;
}

function flattenPages(sections,basePath){
  const flat=[];
  for(const section of sections){
    for(const page of section.pages){
      flat.push({...page,section:section.title,href:`${basePath}/${section.slug}/${page.slug}`});
    }
  }
  return flat;
}

function findPage(sections,basePath,sectionSlug,pageSlug){
  const flat=flattenPages(sections,basePath);
  const index=flat.findIndex(p=>p.href===`${basePath}/${sectionSlug}/${pageSlug}`);
  if(index<0)return null;
  return {page:flat[index],prev:flat[index-1]||null,next:flat[index+1]||null};
}

function sidebarMarkup(sections,basePath,activeHref){
  return sections.map(section=>{
    const items=section.pages.map(page=>{
      const href=`${basePath}/${section.slug}/${page.slug}`;
      const active=href===activeHref;
      return `<a class="docNavLink${active?' active':''}" href="${esc(href)}" data-doc-nav-link>${esc(page.title)}</a>`;
    }).join('');
    return `<div class="docNavSection" data-doc-nav-section><div class="docNavSectionLabel">${esc(section.title)}</div>${items}</div>`;
  }).join('');
}

function guideTools(sidebar){return `<div class="docGuideTools"><input class="docSearch" type="search" placeholder="Search guide…" data-doc-search aria-label="Search guide"><div class="docGuideNav" data-doc-nav>${sidebar}</div></div>`;}

const SHELL_STYLE=`*{box-sizing:border-box}:root{--bg:#090d12;--sidebar:#0d1218;--panel:#121820;--border:#222b36;--text:#dfe6ed;--muted:#8390a0;--accent:#20a9d6}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14.5px;line-height:1.65}a{color:var(--accent)}.docShell{display:flex;min-height:100vh}.docSidebar{width:280px;flex:none;background:var(--sidebar);border-right:1px solid var(--border);padding:20px 14px 40px;overflow-y:auto;position:sticky;top:0;height:100vh}.docBrand{display:block;padding:2px 8px 16px;text-decoration:none}.docBrandSite{font-size:13px;font-weight:800;color:#f4f7fa}.docBrandLabel{font-size:11px;color:var(--muted);margin-top:2px}.docSearch{width:100%;padding:9px 11px;margin-bottom:16px;background:var(--panel);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px}.docSearch::placeholder{color:#586777}.docNavSection{margin-bottom:6px}.docNavSection[hidden]{display:none}.docNavSectionLabel{padding:10px 8px 4px;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#647184}.docNavLink{display:block;padding:7px 9px;border-radius:7px;color:#9aa6b5;text-decoration:none;font-size:13px;font-weight:500}.docNavLink[hidden]{display:none}.docNavLink:hover{background:rgba(32,169,214,.08);color:#eef7fb}.docNavLink.active{background:rgba(32,169,214,.14);color:#fff;box-shadow:inset 3px 0 0 var(--accent)}.docMain{flex:1;min-width:0;max-width:900px;margin:0 auto;padding:44px 48px 80px}.docCrumb{font-size:12.5px;color:var(--muted);margin-bottom:10px}.docCrumb a{color:var(--muted);text-decoration:none}.docCrumb a:hover{color:var(--text)}.docMain h1{margin:0 0 22px;font-size:30px;color:#f4f7fa;line-height:1.2}.docBody h2{margin:36px 0 12px;font-size:20px;color:#eef2f6}.docBody h3{margin:26px 0 10px;font-size:16px;color:#eef2f6}.docBody p{margin:0 0 14px;color:#c3ccd6}.docBody ul,.docBody ol{margin:0 0 14px;padding-left:22px;color:#c3ccd6}.docBody li{margin-bottom:6px}.docBody code{background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.docBody pre{margin:0 0 16px;padding:14px 16px;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow-x:auto}.docBody pre code{background:none;border:none;padding:0;color:#c3ccd6;line-height:1.6}.docBody blockquote{margin:0 0 16px;padding:12px 16px;background:rgba(32,169,214,.07);border-left:3px solid var(--accent);border-radius:0 8px 8px 0}.docBody blockquote p{margin:0;color:#dfe6ed}.docFooterNav{display:flex;justify-content:space-between;gap:16px;margin-top:48px;padding-top:20px;border-top:1px solid var(--border)}.docFooterLink{flex:1;text-decoration:none;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--panel);display:block}.docFooterLink.next{text-align:right}.docFooterLink .docFooterDir{display:block;font-size:11px;color:var(--muted);margin-bottom:3px}.docFooterLink .docFooterTitle{color:#eef2f6;font-weight:600;font-size:13.5px}.docBack{display:inline-block;margin-top:24px;font-size:13px;color:var(--muted);text-decoration:none}.docBack:hover{color:var(--text)}.docGuideTools{margin:0 0 28px;padding:14px;border:1px solid var(--border);border-radius:10px;background:#0d141c}.docGuideTools .docSearch{margin-bottom:10px}.docGuideNav{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px}.docGuideNav .docNavSection{margin:0}.customerDocAccountNav{width:min(1220px,calc(100% - 36px));margin:18px auto 0}.customerDocShell{display:block;min-height:0}.customerDocShell .docMain{max-width:1100px;padding-top:28px}.customerDocShell .docGuideTools{margin-bottom:24px}@media(max-width:820px){.docShell{display:block}.docSidebar{position:static;height:auto;width:auto;border-right:0;border-bottom:1px solid var(--border)}.docMain{padding:28px 20px 56px}.docGuideNav{grid-template-columns:1fr}.customerDocAccountNav{width:calc(100% - 28px);margin-top:14px}.customerDocShell .docMain{padding-top:20px}}@media(max-width:700px){.customerDocAccountNav{width:calc(100% - 24px)}}`;

const SEARCH_SCRIPT_TAG='<script src="/js/docs-search.js" defer></script>';
function customerStyles(accountNavHtml){return accountNavHtml?'<link rel="stylesheet" href="/css/customer-navigation.css"><link rel="stylesheet" href="/css/customer-portal.css">':'';}
function customerTopbar(site){return `<header class="portalTopbar"><div class="portalTopbarInner"><a class="brandLockup" href="/account"><img class="brandLogo" src="/branding/logo" alt=""><div><div class="brandName">${esc(site)}</div><div class="brandMeta">My account</div></div></a><div class="portalActions"><a class="button ghost small" href="/account">Home</a></div></div></header>`;}
function customerAccountNav(accountNavHtml){return accountNavHtml?`<div class="customerDocAccountNav">${accountNavHtml}</div>`:'';}
function shellSidebar({site,basePath,brandLabel,sidebar}){return `<nav class="docSidebar"><a class="docBrand" href="${esc(basePath)}"><div class="docBrandSite">${esc(site)}</div><div class="docBrandLabel">${esc(brandLabel)}</div></a><input class="docSearch" type="search" placeholder="Search guide…" data-doc-search aria-label="Search guide"><div data-doc-nav>${sidebar}</div></nav>`;}
function customerShellStart(site,accountNavHtml){return accountNavHtml?`${customerTopbar(site)}${customerAccountNav(accountNavHtml)}<div class="docShell customerDocShell">`:'<div class="docShell">';}

function renderDocsPage({site,basePath,backHref,backLabel,brandLabel,sections,sectionSlug,pageSlug,accountNavHtml=null}){
  const found=findPage(sections,basePath,sectionSlug,pageSlug);
  if(!found)return null;
  const {page,prev,next}=found;
  const activeHref=`${basePath}/${sectionSlug}/${pageSlug}`;
  const sidebar=sidebarMarkup(sections,basePath,activeHref);
  const bodyHtml=renderMarkdown(page.body);
  const footer=`<div class="docFooterNav">${prev?`<a class="docFooterLink prev" href="${esc(prev.href)}"><span class="docFooterDir">← Previous</span><span class="docFooterTitle">${esc(prev.title)}</span></a>`:'<span></span>'}${next?`<a class="docFooterLink next" href="${esc(next.href)}"><span class="docFooterDir">Next →</span><span class="docFooterTitle">${esc(next.title)}</span></a>`:'<span></span>'}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(page.title)} · ${esc(page.section)} · ${esc(site)}</title>${customerStyles(accountNavHtml)}<style>${SHELL_STYLE}</style></head><body>${customerShellStart(site,accountNavHtml)}${accountNavHtml?'':shellSidebar({site,basePath,brandLabel,sidebar})}<main class="docMain">${accountNavHtml?guideTools(sidebar):''}<div class="docCrumb"><a href="${esc(basePath)}">${esc(brandLabel)}</a> / ${esc(page.section)}</div><h1>${esc(page.title)}</h1><div class="docBody">${bodyHtml}</div>${footer}<a class="docBack" href="${esc(backHref)}">← ${esc(backLabel)}</a></main></div>${SEARCH_SCRIPT_TAG}</body></html>`;
}

function renderDocsIndex({site,basePath,backHref,backLabel,brandLabel,description,sections,accountNavHtml=null}){
  const first=flattenPages(sections,basePath)[0];
  const sidebar=sidebarMarkup(sections,basePath,'');
  const cards=sections.map(section=>`<div class="docIndexCard"><h3>${esc(section.title)}</h3><ul>${section.pages.map(page=>`<li><a href="${esc(basePath)}/${esc(section.slug)}/${esc(page.slug)}">${esc(page.title)}</a></li>`).join('')}</ul></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(brandLabel)} · ${esc(site)}</title>${customerStyles(accountNavHtml)}<style>${SHELL_STYLE}.docIndexGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:32px}.docIndexCard{border:1px solid var(--border);border-radius:12px;padding:18px 20px;background:var(--panel)}.docIndexCard h3{margin:0 0 10px;font-size:14.5px;color:#eef2f6}.docIndexCard ul{margin:0;padding:0;list-style:none}.docIndexCard li{margin-bottom:6px}.docIndexCard a{font-size:13.5px;text-decoration:none}.docIndexCard a:hover{text-decoration:underline}</style></head><body>${customerShellStart(site,accountNavHtml)}${accountNavHtml?'':shellSidebar({site,basePath,brandLabel,sidebar})}<main class="docMain">${accountNavHtml?guideTools(sidebar):''}<h1>${esc(brandLabel)}</h1><div class="docBody"><p>${esc(description)}</p></div>${first?`<p><a href="${esc(first.href)}">Start with “${esc(first.title)}” →</a></p>`:''}<div class="docIndexGrid">${cards}</div><a class="docBack" href="${esc(backHref)}">← ${esc(backLabel)}</a></main></div>${SEARCH_SCRIPT_TAG}</body></html>`;
}

module.exports={renderMarkdown,renderDocsPage,renderDocsIndex,flattenPages,findPage};
