'use strict';

const express=require('express');
const providerSettings=require('../payments/provider-settings');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function providerState(name,status){
  if(!status?.enabled)return `<span class="pill">${esc(name)} off</span>`;
  if(status?.credentialsConfigured&&status?.webhookConfigured)return `<span class="pill good">${esc(name)} ready</span>`;
  return `<span class="pill warn">${esc(name)} needs setup</span>`;
}
function settingsCard(title,description,actions,statusHtml=''){
  return `<section class="settings-card"><div class="card-header"><div><h3>${esc(title)}</h3><div class="settings-hint">${esc(description)}</div></div>${statusHtml}</div><div class="card-body"><div class="quick-actions">${actions.map(([label,href,detail])=>`<a class="quick-action" href="${esc(href)}"><strong>${esc(label)}</strong><span>${esc(detail)}</span></a>`).join('')}</div></div></section>`;
}
async function page(){
  await Promise.all([runtimeSettings.ensureLoaded(),providerSettings.ensureLoaded()]);
  const [stripe,paypal,plisio]=await Promise.all([
    providerSettings.status('stripe'),
    providerSettings.status('paypal'),
    providerSettings.status('plisio')
  ]);
  const body=`<div class="statusBanner"><strong>Commerce settings stay in Settings.</strong> Use this page as the stable configuration directory; open the operational control rooms below only when you need to manage live plans, orders, providers or customer billing.</div><div class="settings-grid settingsCommerceGrid">
    ${settingsCard('Plans & storefront','Products, access policy and the way plans are presented to customers',[
      ['Plans','/admin/plans','Create, edit and retire Jellyfin or Stremio plans'],
      ['Storefront order','/admin/plans/order','Choose how purchasable plans are presented'],
      ['Access rules','/admin/plans/access-rules','Advanced trial, free-access and delivery rules']
    ])}
    ${settingsCard('Payments & billing','Provider credentials, webhook health and recurring billing controls',[
      ['Payment providers','/admin/payments','Stripe, PayPal and Plisio credentials, callbacks and tests'],
      ['Billing','/admin/billing','Recurring subscription and customer billing operations'],
      ['Provider mappings','/admin/provider-mappings','Map CAPTAiNFiN plans to provider-side products'],
      ['Payment risk','/admin/payments/risk-policy','Refund, dispute and chargeback access behaviour']
    ],`<div class="settingsCommerceProviderState">${providerState('Stripe',stripe)}${providerState('PayPal',paypal)}${providerState('Plisio',plisio)}</div>`)}
    ${settingsCard('Orders & growth','Purchase history, revenue reporting and commercial growth tools',[
      ['Orders','/admin/commerce/orders','Trace Stripe and PayPal purchases back to customers'],
      ['Commerce analytics','/admin/commerce','Revenue, MRR, churn and upcoming access risk'],
      ['Discounts','/admin/discounts','Promotions, coupon rules and redemptions'],
      ['Affiliates','/admin/referrals','Referral attribution and service-credit rewards']
    ])}
  </div>`;
  return layout({siteName:runtimeSettings.siteName(),active:'settings-commerce',title:'Settings · Commerce',subtitle:'Commercial configuration and canonical entry points without leaving Settings',body,pageClass:'page-settings-commerce'});
}
function createAdminSettingsCommerceRouter(){
  const router=express.Router();
  router.use('/admin/settings/commerce',gate,noStore);
  router.get('/admin/settings/commerce',async(_req,res,next)=>{
    try{return res.send(await page());}catch(error){return next(error);}
  });
  return router;
}
module.exports={createAdminSettingsCommerceRouter,page,settingsCard,providerState};
