'use strict';
const express=require('express');
const customers=require('../customers');
const runtimeSettings=require('./runtime-settings');
const supportPolicy=require('./support-policy');
const branding=require('./branding');
const publicShell=require('./public-shell');
const {esc}=require('./admin-html');

function contactLink(label,url){return url?`<a class="infoAction" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:''}
function infoShell(site,title,subtitle,body,{nav={},active='',logged=false,registrationOpen=false,support={}}={}){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><link rel="stylesheet" href="/css/storefront.css"><link rel="stylesheet" href="/css/storefront-refinement.css"><link rel="stylesheet" href="/css/public-info-pages.css"></head><body><div class="siteBackdrop" aria-hidden="true"><div class="backdropGlow glowA"></div><div class="backdropGlow glowB"></div><div class="backdropGrid"></div></div>${publicShell.publicHeader({site,nav,active,logged,registrationOpen})}<main class="infoMain"><section class="storeWrap infoHero"><div class="heroEyebrow"><span class="liveDot"></span>CAPTAiNFiN information</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></section>${body}</main>${publicShell.publicFooter({site,support,registrationOpen})}</body></html>`;
}
function card(title,copy){return `<article class="infoCard"><h2>${esc(title)}</h2><p>${esc(copy)}</p></article>`}
async function baseData(req){
  await runtimeSettings.ensureLoaded();
  const [support,plans]=await Promise.all([
    supportPolicy.get().catch(()=>({})),
    customers.listPublicPlans().catch(()=>[])
  ]);
  return{
    site:runtimeSettings.siteName(),
    support,
    nav:publicShell.navFromPlans(plans),
    registrationOpen:runtimeSettings.publicRegistrationOpen(),
    logged:Boolean(req?.session?.customerId)
  };
}
function shellData(data,active=''){return{nav:data.nav,active,logged:data.logged,registrationOpen:data.registrationOpen,support:data.support}}
function createPublicPagesRouter(){
  const router=express.Router();
  router.get('/api/platform/plans',async(_req,res,next)=>{try{return res.json(await customers.listPublicPlans());}catch(error){return next(error);}});
  router.get('/about',async(req,res,next)=>{try{const data=await baseData(req),{site}=data;return res.send(infoShell(site,'About CAPTAiNFiN','A private access portal for managing streaming membership, customer accounts and support in one place.',`<section class="storeWrap infoGrid">${card('Built for simple access','CAPTAiNFiN gives customers one account for plans, Jellyfin access, Stremio setup, security and support.')}${card('Clear operations','The administration area tracks customers, servers, commerce, automation and attention items from a single control centre.')}${card('Professional by design','The interface keeps billing, access and server-health decisions visible without exposing raw secrets or unnecessary internal identifiers.')}</section>`,shellData(data,'about')));}catch(error){next(error);}});
  router.get('/faq',async(req,res,next)=>{try{const data=await baseData(req),{site,support}=data,supportEmail=support.supportEmail||'';const faqs=[['How do I start?','Create or sign in to your customer account, choose an available plan, then follow the access setup shown in your portal.'],['Why can I not sign in to Jellyfin?','Check that your Jellyfin password has been set in the customer portal and that your account is marked Ready.'],['Where is Stremio setup?','Eligible plans show Stremio setup inside the customer portal. Use that page to install your personal add-on link.'],['Can I change plans?','Available plan changes are shown under Plans & billing. The portal explains whether a change starts now or at renewal.'],['How do I get help?',supportEmail?`Contact support at ${supportEmail}.`:'Use the Contact page for the currently configured support option.']];return res.send(infoShell(site,'FAQ','Quick answers for account, billing, Jellyfin and Stremio setup questions.',`<section class="storeWrap faqList">${faqs.map(([q,a])=>`<details class="faqItem"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>`,shellData(data,'faq')));}catch(error){next(error);}});
  router.get('/contact',async(req,res,next)=>{try{const data=await baseData(req),{site,support}=data;const actions=[support.supportEmail?`<a class="infoAction primary" href="mailto:${esc(support.supportEmail)}">Email ${esc(support.supportEmail)}</a>`:'',contactLink('Support link',support.supportUrl),contactLink('Docs',support.docsUrl),contactLink('Service status',support.statusUrl)].filter(Boolean).join('');return res.send(infoShell(site,'Contact','Get help with account access, billing, Jellyfin, Stremio or service questions.',`<section class="storeWrap contactPanel"><div><h2>Support routes</h2><p>Include your customer username and a short description of what you were trying to do. Do not send passwords or payment card details.</p></div><div class="infoActions">${actions||'<span class="infoMuted">No public support destination has been configured yet.</span>'}</div></section>`,shellData(data,'contact')));}catch(error){next(error);}});
  router.get('/trust',async(req,res,next)=>{try{const data=await baseData(req),{site}=data;return res.send(infoShell(site,'Trust & security','How CAPTAiNFiN keeps operational access, credentials and support workflows understandable.',`<section class="storeWrap infoGrid">${card('Credential boundaries','Customer portal passwords, Jellyfin passwords and payment-provider credentials are separate. Administrators do not see your passwords.')}${card('Operational visibility','Server health, provisioning failures, payment incidents and Stremio source failures appear in Needs Attention for administrator follow-up.')}${card('Safer support','Support should never ask for your password. Use official support destinations and keep sensitive payment details out of messages.')}</section>`,shellData(data,'trust')));}catch(error){next(error);}});
  router.get(['/terms','/privacy','/refund-policy'],async(req,res,next)=>{
    try{
      const data=await baseData(req),{site,support}=data;
      const map={'/terms':['Terms','termsUrl'],'/privacy':['Privacy','privacyUrl'],'/refund-policy':['Refund policy','refundPolicyUrl']};
      const [title,key]=map[req.path],configured=support[key];
      const body=configured
        ? `<section class="storeWrap contactPanel"><div><h2>Official ${esc(title.toLowerCase())}</h2><p>The operator has configured an external document for the full current policy.</p></div><div class="infoActions">${contactLink(`Open ${title}`,configured)}</div></section>`
        : `<section class="storeWrap contactPanel"><div><h2>${esc(title)} not configured yet</h2><p>The operator should configure the final public ${esc(title.toLowerCase())} document in Admin Settings before relying on this page as legal text.</p></div><div class="infoActions"><a class="infoAction" href="/contact">Contact support</a></div></section>`;
      return res.send(infoShell(site,title,`${title} information for this CAPTAiNFiN service.`,body,shellData(data)));
    }catch(error){next(error);}
  });
  return router;
}
module.exports={createPublicPagesRouter,infoShell,baseData};
