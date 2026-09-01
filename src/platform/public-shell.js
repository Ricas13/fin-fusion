'use strict';

const branding=require('./branding');
const serviceCatalog=require('../catalog/service-catalog');
const{esc}=require('./admin-html');

function navFromPlans(plans=[]){
  const groups=serviceCatalog.storefrontGroups(plans);
  return{
    free:groups.free.length>0,
    plans:groups.plans.length>0,
    stremio:groups.stremio.length>0,
    emby:groups.emby.length>0
  };
}

function navItems(nav={}){
  return[
    nav.free&&['free','Free','/#free-access'],
    nav.plans&&['plans','Plans','/#plans'],
    nav.stremio&&['stremio','Stremio','/#stremio'],
    nav.emby&&['emby','Emby Shares','/#emby'],
    ['about','About','/about'],
    ['faq','FAQ','/faq'],
    ['help','Help','/help'],
    ['contact','Contact','/contact'],
    ['trust','Trust','/trust']
  ].filter(Boolean);
}

function publicHeader({site,nav={},active='',logged=false,registrationOpen=false}={}){
  const links=navItems(nav).map(([key,label,href])=>{
    const current=active===key;
    return `<a${current?' class="active" aria-current="page"':''} href="${esc(href)}">${esc(label)}</a>`;
  }).join('');
  const accountAction=logged
    ? '<a class="storeBtn primary small" href="/account">My account</a>'
    : registrationOpen
      ? '<a class="storeBtn primary small" href="/account/register">Get started</a>'
      : '';
  return `<header class="storeHeader"><div class="storeWrap headerInner"><a class="storeBrand" href="/" aria-label="${esc(site)} home"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site)}</span></a><nav class="storeNav" aria-label="Main navigation">${links}</nav><div class="headerActions"><a class="storeBtn ghost" href="/account/login">Sign in</a>${accountAction}</div></div></header>`;
}

function supportLinks(policy={}){
  const links=[['Support',policy.supportUrl],['Status',policy.statusUrl],['Terms',policy.termsUrl],['Privacy',policy.privacyUrl],['Refund policy',policy.refundPolicyUrl]].filter(([,url])=>url);
  const email=policy.supportEmail?`<a href="mailto:${esc(policy.supportEmail)}">${esc(policy.supportEmail)}</a>`:'';
  if(!links.length&&!email)return'';
  return `<div class="storeWrap supportLinks"><strong>Help & policies:</strong> ${links.map(([label,url])=>`<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>`).join(' · ')}${links.length&&email?' · ':''}${email}</div>`;
}

function publicFooter({site,support={},registrationOpen=false}={}){
  const supportEmail=String(support.supportEmail||'').trim();
  return `<footer class="storeFooter"><div class="storeWrap footerGrid"><div><a class="storeBrand footerBrand" href="/"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site)}</span></a><p>Simple access, managed from one place.</p></div><div class="footerLinks"><div><strong>Account</strong><a href="/account/login">Customer sign in</a>${registrationOpen?'<a href="/account/register">Create account</a>':''}</div><div><strong>Help</strong><a href="/help">Help centre</a><a href="/faq">FAQ</a><a href="/contact">Contact</a><a href="/trust">Trust & security</a>${supportEmail?`<a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>`:'<span>Contact your service administrator</span>'}</div></div></div>${supportLinks(support)}<div class="storeWrap footerBottom"><span>© ${new Date().getFullYear()} ${esc(site)}</span><a href="/login">Administration</a></div></footer>`;
}

module.exports={navFromPlans,navItems,publicHeader,publicFooter,supportLinks};
