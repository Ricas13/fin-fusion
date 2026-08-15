'use strict';

const core = require('./storefront-core');
const customers = require('../customers');
const runtimeSettings = require('./runtime-settings');
const monthly = require('../resellers/monthly');
const requestServiceSettings = require('../integrations/request-service-settings');
const { esc } = require('./admin-html');

function money(minor,currency='GBP') {
    try { return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:Number(minor)%100?2:0,maximumFractionDigits:2}).format(Number(minor||0)/100); }
    catch (_) { return `${currency} ${(Number(minor||0)/100).toFixed(2)}`; }
}

function normalizedPlans(plans) {
    return (plans || []).map(plan => ({
        ...plan,
        // Storefront v2 used pre-quota field names. Alias the actual migration
        // 028 fields so its proven card renderer shows the configured limits.
        movie_request_limit: plan.request_movie_quota_limit,
        movie_request_days: plan.request_movie_quota_days,
        tv_request_limit: plan.request_tv_quota_limit,
        tv_request_days: plan.request_tv_quota_days
    }));
}

function resellerSection(tiers,supportEmail='') {
    if (!tiers?.length) return '';
    const target = supportEmail ? `mailto:${supportEmail}?subject=${encodeURIComponent('Reseller account')}` : '/login';
    const cards = tiers.map((tier,index)=>`<article class="planCard ${index===1&&tiers.length>=3?'featured':''}">
        <div class="planGlow" aria-hidden="true"></div>
        <div class="planCardTop"><div><div class="planName">${esc(tier.name)}</div><div class="planInterval">monthly reseller plan</div></div>${index===1&&tiers.length>=3?'<span class="planBadge featuredBadge">Popular</span>':''}</div>
        <p class="planDescription">${esc(tier.description||'Run a managed customer estate with recurring monthly capacity.')}</p>
        <div class="planPriceRow"><span class="planPrice">${esc(money(tier.monthly_price_minor,tier.currency))}</span><span class="planPer">/ month</span></div>
        <div class="planEquivalent">${esc(tier.seat_limit)} active customer entitlement${Number(tier.seat_limit)===1?'':'s'}</div>
        <ul class="planFeatures"><li>Your own account can use one seat</li><li>Customer and revenue dashboard</li><li>Automatic Jellyfin provisioning</li><li>Configurable downstream plans</li><li>Recurring billing and paid-through protection</li></ul>
        <a class="storeBtn ${index===1&&tiers.length>=3?'primary':'secondary'} full" href="${esc(target)}">${supportEmail?'Apply to become a reseller':'Reseller sign in'}</a>
    </article>`).join('');
    return `<section class="storeSection pricingSection" id="resellers"><div class="storeWrap"><div class="sectionIntro"><div class="sectionKicker">Build your own customer base</div><h2>Monthly reseller plans.</h2><p>Pay a fixed monthly fee for a defined number of active customer entitlements. Billing and access remain separate from the prices you charge your own customers.</p></div><div class="pricingGrid">${cards}</div><div class="storeNotice"><strong>Reseller access:</strong> reseller billing controls the parent estate. Individual customer sales and renewal history remain visible in the reseller portal.</div></div></section>`;
}

function renderStorefront({ site, plans, store, registrationOpen, logged, resellerTiers = [], requestConfigured = false }) {
    const normalized = normalizedPlans(plans);
    let html = core.renderStorefront({ site, plans: normalized, store, registrationOpen, logged });
    const maxStreams = normalized.length ? Math.max(...normalized.map(plan => Number(plan.streams || 0))) : 0;
    if (maxStreams) html = html.replace(/>3 streams</g, `>${maxStreams} stream${maxStreams===1?'':'s'}<`);
    html = html.replace('Central content requests', requestConfigured ? 'Central content requests' : 'Self-service account portal');

    const section = resellerSection(resellerTiers, String(store?.copy?.supportEmail || '').trim());
    if (section) {
        const navNeedle = '<a href="#plans">Plans</a><a href="#how">How it works</a>';
        if (html.includes(navNeedle)) html = html.replace(navNeedle, '<a href="#plans">Plans</a><a href="#resellers">Resellers</a><a href="#how">How it works</a>');
        const how = '<section class="storeSection howSection" id="how">';
        html = html.includes(how) ? html.replace(how, `${section}\n\n    ${how}`) : html.replace('</main>', `${section}</main>`);
    }
    return html;
}

async function storefrontPage(req,res) {
    try {
        await runtimeSettings.ensureLoaded();
        const site = runtimeSettings.siteName();
        if (!runtimeSettings.storefrontEnabled()) {
            res.setHeader('Cache-Control','no-store, private, max-age=0');
            return res.status(404).send(core.disabledPage(site));
        }
        const [plans,store,resellerTiers,requestStatus] = await Promise.all([
            customers.listPublicPlans(), core.settings(), monthly.listTiers({ visibleOnly:true, activeOnly:true }), requestServiceSettings.status().catch(()=>({configured:false}))
        ]);
        const registrationOpen = runtimeSettings.publicRegistrationOpen();
        const logged = Boolean(req.session?.customerId);
        res.setHeader('Cache-Control',logged?'no-store, private, max-age=0':'public, max-age=60');
        return res.send(renderStorefront({ site,plans,store,registrationOpen,logged,resellerTiers,requestConfigured:Boolean(requestStatus.configured) }));
    } catch (error) {
        console.error('Storefront failed:',error.message);
        return res.status(500).send('Store temporarily unavailable');
    }
}

module.exports = {
    ...core,
    storefrontPage,
    renderStorefront,
    resellerSection,
    normalizedPlans
};
