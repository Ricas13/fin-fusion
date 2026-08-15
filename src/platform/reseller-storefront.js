'use strict';

const express = require('express');
const customers = require('../customers');
const runtimeSettings = require('./runtime-settings');
const storefront = require('./storefront');
const monthly = require('../resellers/monthly');
const { esc } = require('./admin-html');

function money(minor,currency='GBP'){
    try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:Number(minor)%100?2:0,maximumFractionDigits:2}).format(Number(minor||0)/100);}
    catch{return `${currency} ${(Number(minor||0)/100).toFixed(2)}`;}
}

function resellerSection(tiers,supportEmail){
    if(!tiers.length)return'';
    const contact=supportEmail?`mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent('CAPTaINFiN reseller account')}`:'/login';
    const cards=tiers.map((tier,index)=>`<article class="planCard ${index===1&&tiers.length>=3?'featured':''}">
        <div class="planGlow" aria-hidden="true"></div>
        <div class="planCardTop"><div><div class="planName">${esc(tier.name)}</div><div class="planInterval">monthly reseller plan</div></div>${index===1&&tiers.length>=3?'<span class="planBadge featuredBadge">Popular</span>':''}</div>
        <p class="planDescription">${esc(tier.description||'Run your own managed customer estate with recurring monthly capacity.')}</p>
        <div class="planPriceRow"><span class="planPrice">${esc(money(tier.monthly_price_minor,tier.currency))}</span><span class="planPer">/ month</span></div>
        <div class="planEquivalent">Recurring monthly reseller access</div>
        <ul class="planFeatures"><li>Up to ${esc(tier.seat_limit)} active Jellyfin account${Number(tier.seat_limit)===1?'':'s'}</li><li>Your own Jellyfin account counts as one</li><li>Reseller revenue & customer dashboard</li><li>Automatic Jellyfin provisioning</li><li>Manual downstream customer sales</li></ul>
        <a class="storeBtn ${index===1&&tiers.length>=3?'primary':'secondary'} full" href="${esc(contact)}">${supportEmail?'Apply to become a reseller':'Reseller sign in'}</a>
    </article>`).join('');
    return `<section class="storeSection pricingSection" id="resellers"><div class="storeWrap"><div class="sectionIntro"><div class="sectionKicker">Build your own customer base</div><h2>Monthly reseller plans.</h2><p>Pay a fixed amount every month for an active-customer allowance. Reseller accounts are approved by the service administrator.</p></div><div class="pricingGrid">${cards}</div><div class="storeNotice"><strong>How reseller access works:</strong> your reseller subscription stays recurring monthly. If it becomes unpaid or expires, your reseller-managed Jellyfin estate is suspended until the subscription is restored.</div></div></section>`;
}

function inject(html,section){
    if(!section)return html;
    const navNeedle='<a href="#plans">Plans</a><a href="#how">How it works</a>';
    if(html.includes(navNeedle)) html=html.replace(navNeedle,'<a href="#plans">Plans</a><a href="#resellers">Resellers</a><a href="#how">How it works</a>');
    const how='<section class="storeSection howSection" id="how">';
    if(html.includes(how)) return html.replace(how,`${section}\n\n    ${how}`);
    return html.replace('</main>',`${section}</main>`);
}

function createResellerStorefrontRouter(){
    const router=express.Router();
    router.get('/',async(req,res,next)=>{
        try{
            await runtimeSettings.ensureLoaded();
            if(!runtimeSettings.storefrontEnabled()) return storefront.storefrontPage(req,res);
            const [plans,store,tiers]=await Promise.all([
                customers.listPublicPlans(),storefront.settings(),monthly.listTiers({visibleOnly:true,activeOnly:true})
            ]);
            const site=runtimeSettings.siteName?runtimeSettings.siteName():(process.env.SITE_NAME||'CAPTaINFiN');
            const registrationOpen=runtimeSettings.publicRegistrationOpen();
            const logged=Boolean(req.session?.customerId);
            const supportEmail=String(store.copy?.supportEmail||'').trim();
            const html=storefront.renderStorefront({site,plans,store,registrationOpen,logged});
            res.setHeader('Cache-Control',logged?'no-store, private, max-age=0':'public, max-age=60');
            return res.send(inject(html,resellerSection(tiers,supportEmail)));
        }catch(error){
            console.error('Reseller storefront extension failed:',error.message);
            return next(error);
        }
    });
    return router;
}

module.exports={createResellerStorefrontRouter,resellerSection,inject};
