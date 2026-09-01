'use strict';

const moneyFormat=require('./money-format');

const { query } = require('../db');
const customers = require('../customers');
const { esc } = require('./admin-html');
const runtimeSettings = require('./runtime-settings');
const branding = require('./branding');
const planComponents = require('../access/plan-components');

const DEFAULT_FEATURES = [
    'A huge movie and TV library',
    'Flexible Jellyfin access and standalone Stremio household access',
    'Downloads available on supported plans',
    'Watch on TVs, phones, tablets and browsers',
    'One simple self-service customer account',
    'Request new content from one central place'
];

async function settings() {
    const result = await query(`
        SELECT setting_key,setting_value
        FROM platform_settings
        WHERE setting_key IN ('storefront','storefront_features')
    `);
    const values = Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value]));
    return {
        copy: values.storefront || {},
        features: Array.isArray(values.storefront_features) && values.storefront_features.length
            ? values.storefront_features
            : DEFAULT_FEATURES
    };
}

function money(minor, currency = 'USD') {
    if (!Number(minor || 0)) return 'Free';
    return moneyFormat.formatMinor(minor,currency,{trimZeroDecimals:true});
}

function intervalLabel(plan) {
    const labels = {
        trial: 'trial',
        month: 'month',
        '6_months': '6 months',
        year: 'year',
        custom: plan.duration_days ? `${plan.duration_days} days` : 'access period'
    };
    return labels[plan.billing_interval] || String(plan.billing_interval || '').replace(/_/g, ' ');
}

function billingMonths(plan) {
    if (plan.billing_interval === 'month') return 1;
    if (plan.billing_interval === '6_months') return 6;
    if (plan.billing_interval === 'year') return 12;
    if (plan.duration_days && Number(plan.duration_days) >= 25) return Number(plan.duration_days) / 30.4375;
    return null;
}

function monthlyBaseline(plans, currency) {
    const monthly = plans.find(plan =>
        plan.billing_interval === 'month'
        && Number(plan.price_minor || 0) > 0
        && String(plan.currency || 'USD') === String(currency || 'USD')
    );
    return monthly ? Number(monthly.price_minor) : null;
}

function savingForPlan(plan, plans) {
    const months = billingMonths(plan);
    if (!months || months <= 1 || Number(plan.price_minor || 0) <= 0) return 0;
    const baseline = monthlyBaseline(plans, plan.currency);
    if (!baseline) return 0;
    return Math.max(0, Math.round(baseline * months - Number(plan.price_minor)));
}

function monthlyEquivalent(plan) {
    const months = billingMonths(plan);
    if (!months || months <= 1 || Number(plan.price_minor || 0) <= 0) return null;
    return Math.round(Number(plan.price_minor) / months);
}

function bestValueCode(plans) {
    let best = { code: null, saving: 0 };
    for (const plan of plans) {
        const saving = savingForPlan(plan, plans);
        if (saving > best.saving) best = { code: plan.code, saving };
    }
    return best.code;
}

function planService(plan){const value=String(plan?.service_type||plan?.service_type_snapshot||'jellyfin').toLowerCase();return['jellyfin','stremio','bundle'].includes(value)?value:'jellyfin';}
function accessModel(plan){return planComponents.accessLabel(plan)||'Streaming access';}

function targetForPlan(plan, { logged, registrationOpen }) {
    if (logged) return '/account#plans';
    if (registrationOpen) return '/account/register';
    return '/account/login?next=' + encodeURIComponent('/account#plans');
}

function ctaForPlan(plan, { logged, registrationOpen }) {
    if (logged) return Number(plan.price_minor || 0) === 0 ? 'Choose this plan' : 'Continue in account';
    if (registrationOpen) return plan.billing_interval === 'trial' ? 'Start free trial' : 'Get started';
    return 'Sign in to choose';
}

function quotaLine(plan) {
    const movie = Number(plan.movie_request_limit || 0);
    const tv = Number(plan.tv_request_limit || 0);
    if (!movie && !tv) return '';
    const bits = [];
    if (movie) bits.push(`${movie} movie request${movie === 1 ? '' : 's'}`);
    if (tv) bits.push(`${tv} TV request${tv === 1 ? '' : 's'}`);
    return `<li>${esc(bits.join(' + '))}</li>`;
}

function planCard(plan, plans, context, featuredCode) {
    const featured = featuredCode && String(plan.code) === String(featuredCode);
    const saving = savingForPlan(plan, plans);
    const equivalent = monthlyEquivalent(plan);
    const target = targetForPlan(plan, context);
    const price = money(plan.price_minor, plan.currency);
    const interval = intervalLabel(plan);
    const paid = Number(plan.price_minor || 0) > 0;
    const type=planService(plan),stremioOnly=type==='stremio';
    const description = plan.description || (plan.billing_interval === 'trial'
        ? 'Try the service before choosing a paid plan.'
        : 'Streaming access managed from your customer account.');

    const badge = featured
        ? '<span class="planBadge featuredBadge">Best value</span>'
        : saving > 0
            ? `<span class="planBadge">Save ${esc(money(saving, plan.currency))}</span>`
            : plan.billing_interval === 'trial'
                ? '<span class="planBadge trialBadge">Try it first</span>'
                : '';

    const equivalentText = equivalent
        ? `<div class="planEquivalent">About ${esc(money(equivalent, plan.currency))} / month</div>`
        : '<div class="planEquivalent">&nbsp;</div>';

    return `<article class="planCard ${featured ? 'featured' : ''}">
        <div class="planGlow" aria-hidden="true"></div>
        <div class="planCardTop">
            <div><div class="planName">${esc(plan.name)}</div><div class="planInterval">${esc(interval)}</div></div>
            ${badge}
        </div>
        <p class="planDescription">${esc(description)}</p>
        <div class="planPriceRow"><span class="planPrice">${esc(price)}</span>${paid ? `<span class="planPer">/ ${esc(interval)}</span>` : ''}</div>
        ${equivalentText}
        <ul class="planFeatures">
            <li>${esc(accessModel(plan))}</li>
            <li>${stremioOnly?'Private Stremio installation':plan.allow_downloads?'Downloads included':'Streaming access'}</li>
            ${stremioOnly?'':plan.allow_video_transcoding ? '<li>Video transcoding available</li>' : '<li>Direct playback focused</li>'}
            ${quotaLine(plan)}
        </ul>
        <a class="storeBtn ${featured ? 'primary' : 'secondary'} full" href="${esc(target)}">${esc(ctaForPlan(plan, context))}</a>
    </article>`;
}

function featureIcon(index) {
    const icons = [
        '<path d="M4 7h16v10H4z"/><path d="m9 7 2-3h2l2 3"/><path d="M8 12h8"/>',
        '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/>',
        '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
        '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
        '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
        '<path d="M4 6h16v12H4z"/><path d="m9 10 3 2 3-2M9 14h6"/>'
    ];
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[index % icons.length]}</svg>`;
}

function heroVisual() {
    return `<div class="heroVisual" aria-hidden="true">
        <div class="visualOrb orbOne"></div><div class="visualOrb orbTwo"></div>
        <div class="screenMock">
            <div class="screenTop"><span></span><span></span><span></span></div>
            <div class="screenHero"><div class="screenLogo">CF</div><div><b>Ready when you are</b><small>Movies · Series · More</small></div></div>
            <div class="posterRow">
                <div class="poster p1"><span>FILM</span></div><div class="poster p2"><span>SERIES</span></div><div class="poster p3"><span>NEW</span></div><div class="poster p4"><span>4K</span></div>
            </div>
            <div class="screenLines"><i></i><i></i><i></i></div>
        </div>
        <div class="floatingChip chipOne"><b>✓</b><span>access</span></div>
        <div class="floatingChip chipTwo"><b>✓</b><span>downloads</span></div>
    </div>`;
}

function disabledPage(site) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><style>html,body{margin:0;min-height:100%;background:#080b10;color:#f4f7fa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.closed{min-height:100vh;display:grid;place-items:center;padding:24px}.closedCard{width:min(520px,100%);border:1px solid #28303a;border-radius:18px;background:#10161e;padding:30px}.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px}.brand img{width:38px;height:38px;border-radius:9px;object-fit:cover}.muted{color:#8794a5;line-height:1.6}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.actions a{color:#d9e0e8;text-decoration:none;border:1px solid #32404d;border-radius:9px;padding:10px 13px}</style></head><body><main class="closed"><section class="closedCard"><div class="brand"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site)}</span></div><h1>Storefront not enabled</h1><p class="muted">This installation is not currently publishing a public storefront. Existing customers and administrators can still sign in.</p><div class="actions"><a href="/account/login">Customer sign in</a><a href="/login">Administration</a></div></section></main></body></html>`;
}

function renderStorefront({ site, plans, store, registrationOpen, logged }) {
    const context = { logged, registrationOpen };
    plans = plans.filter(plan => !plan.is_addon && planService(plan) !== 'bundle');
    const paidPlans = plans.filter(plan => Number(plan.price_minor || 0) > 0);
    const jellyfinPlans=plans.filter(plan=>planService(plan)==='jellyfin');
    const streamPlans=jellyfinPlans.filter(plan=>planComponents.componentForPlan(plan,'jellyfin')?.driver==='concurrent_streams');
    const maxStreams=streamPlans.length?Math.max(...streamPlans.map(plan=>planComponents.componentForPlan(plan,'jellyfin').config.streamLimit)):null;
    const hasJellyfinHousehold=jellyfinPlans.some(plan=>planComponents.componentForPlan(plan,'jellyfin')?.driver==='household_network');
    const hasStremio=plans.some(plan=>planService(plan)==='stremio');
    const hasTrial = plans.some(plan => plan.billing_interval === 'trial');
    const featuredCode = bestValueCode(plans);
    const planMarkup = plans.length
        ? plans.map(plan => planCard(plan, plans, context, featuredCode)).join('')
        : '<div class="storeNotice">No public plans are available yet.</div>';
    const features = store.features.length ? store.features : DEFAULT_FEATURES;
    const primaryTarget = logged ? '/account' : registrationOpen ? '/account/register' : '/account/login';
    const primaryLabel = logged ? 'Open my account' : registrationOpen ? (hasTrial ? 'Start free trial' : 'Get started') : 'Customer sign in';
    const announcement = String(store.copy.announcement || '').trim();
    const supportEmail = String(store.copy.supportEmail || '').trim();
    const cheapestPaid = paidPlans.slice().sort((a, b) => {
        const am = monthlyEquivalent(a) || Number(a.price_minor || 0);
        const bm = monthlyEquivalent(b) || Number(b.price_minor || 0);
        return am - bm;
    })[0] || null;
    const jellyfinProof=maxStreams?{value:maxStreams,label:'max Jellyfin streams'}:hasJellyfinHousehold?{value:'Home',label:'Jellyfin household option'}:{value:'—',label:'Jellyfin optional'};

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="#070a0f">
    <title>${esc(site)} · Stream your way</title>
    <meta name="description" content="${esc(store.copy.heroSubtitle || 'Simple streaming access with flexible plans and one customer account.')}">
    <link rel="icon" href="${esc(branding.assetUrl('favicon'))}">
    <link rel="stylesheet" href="/css/storefront.css">
</head>
<body>
<div class="siteBackdrop" aria-hidden="true"><div class="backdropGlow glowA"></div><div class="backdropGlow glowB"></div><div class="backdropGrid"></div></div>
<header class="storeHeader">
    <div class="storeWrap headerInner">
        <a class="storeBrand" href="/" aria-label="${esc(site)} home"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site)}</span></a>
        <nav class="storeNav" aria-label="Main navigation"><a href="#features">Features</a><a href="#plans">Plans</a><a href="#how">How it works</a></nav>
        <div class="headerActions"><a class="storeBtn ghost" href="/account/login">Sign in</a>${logged ? '<a class="storeBtn primary small" href="/account">My account</a>' : registrationOpen ? '<a class="storeBtn primary small" href="/account/register">Get started</a>' : ''}</div>
    </div>
</header>
<main>
    <section class="heroSection">
        <div class="storeWrap heroGrid">
            <div class="heroCopy">
                ${announcement ? `<div class="announcement"><span>New</span>${esc(announcement)}</div>` : '<div class="heroEyebrow"><span class="liveDot"></span>Entertainment on your terms</div>'}
                <h1>${esc(store.copy.heroTitle || 'Your entertainment. One simple subscription.')}</h1>
                <p class="heroLead">${esc(store.copy.heroSubtitle || 'Stream movies and TV with flexible access and a simple customer account.')}</p>
                <div class="heroActions"><a class="storeBtn primary large" href="${esc(primaryTarget)}">${esc(primaryLabel)} <span aria-hidden="true">→</span></a><a class="storeBtn secondary large" href="#plans">Compare plans</a></div>
                <div class="heroProof">
                    <div><strong>${esc(jellyfinProof.value)}</strong><span>${esc(jellyfinProof.label)}</span></div>
                    <div><strong>${hasStremio?'Yes':'—'}</strong><span>Stremio household options</span></div>
                    <div><strong>${hasTrial ? '24h' : `${plans.length}`}</strong><span>${hasTrial ? 'trial available' : 'plans available'}</span></div>
                </div>
            </div>
            ${heroVisual()}
        </div>
        <div class="storeWrap trustStrip">
            <span>One account</span><i></i><span>Multiple devices</span><i></i><span>Simple plan management</span><i></i><span>Central content requests</span>${cheapestPaid ? `<div class="trustPrice">Plans from <strong>${esc(money(monthlyEquivalent(cheapestPaid) || cheapestPaid.price_minor, cheapestPaid.currency))}</strong> / month</div>` : ''}
        </div>
    </section>

    <section class="storeSection featureSection" id="features">
        <div class="storeWrap">
            <div class="sectionIntro"><div class="sectionKicker">Built around the way you watch</div><h2>${esc(store.copy.featureTitle || 'Everything you need to watch your way')}</h2><p>Simple access without a complicated customer experience.</p></div>
            <div class="featureGrid">${features.slice(0, 6).map((feature, index) => `<article class="featureCard"><div class="featureIcon">${featureIcon(index)}</div><div class="featureNumber">0${index + 1}</div><h3>${esc(feature)}</h3></article>`).join('')}</div>
        </div>
    </section>

    <section class="storeSection experienceSection">
        <div class="storeWrap experienceGrid">
            <div class="experienceVisual" aria-hidden="true"><div class="device desktop"><div class="deviceScreen"><span class="playCircle">▶</span><div class="mediaGradient"></div></div></div><div class="device phone"><div class="phoneNotch"></div><div class="phoneScreen"><span class="playCircle smallPlay">▶</span></div></div></div>
            <div class="experienceCopy"><div class="sectionKicker">Watch wherever you are</div><h2>Your account follows you from screen to screen.</h2><p>Use the service on supported TVs, browsers, phones and tablets. Your plan and account stay in one place.</p><div class="deviceTags"><span>Smart TV</span><span>Browser</span><span>iPhone / iPad</span><span>Android</span><span>Tablet</span></div></div>
        </div>
    </section>

    <section class="storeSection pricingSection" id="plans">
        <div class="storeWrap">
            <div class="sectionIntro"><div class="sectionKicker">Straightforward pricing</div><h2>Choose the access that fits you.</h2><p>No mystery tiers. Compare the plans available right now.</p></div>
            <div class="pricingGrid">${planMarkup}</div>
            ${registrationOpen ? '' : '<div class="storeNotice"><strong>Already a customer?</strong> Sign in to manage or renew your access. New customer signup is currently managed by the service administrator.</div>'}
        </div>
    </section>

    <section class="storeSection howSection" id="how">
        <div class="storeWrap">
            <div class="sectionIntro"><div class="sectionKicker">Three simple steps</div><h2>From account to watching in minutes.</h2></div>
            <div class="stepsGrid">
                <article class="stepCard"><span>01</span><h3>${registrationOpen ? 'Create your account' : 'Sign in with your portal account'}</h3><p>${registrationOpen ? 'Set up your customer account and choose how you want to access the service.' : 'Existing customers can sign in. New customers are added or imported by the service administrator.'}</p></article>
                <article class="stepCard"><span>02</span><h3>Choose your plan</h3><p>Compare Jellyfin stream or household access, Stremio household access, downloads and plan duration, then choose the option that works for you.</p></article>
                <article class="stepCard"><span>03</span><h3>Set up and watch</h3><p>Your streaming access is managed from one customer portal, including account settings and content requests.</p></article>
            </div>
        </div>
    </section>

    <section class="finalCtaSection">
        <div class="storeWrap finalCta"><div><div class="sectionKicker">Ready when you are</div><h2>${logged ? 'Everything is waiting in your account.' : registrationOpen ? 'Start watching your way.' : 'Already have access?'}</h2><p>${logged ? 'Open your customer portal to manage your plan and streaming access.' : registrationOpen ? 'Create an account, choose your access and get started.' : 'Sign in to your customer portal to manage your plan, streaming access and requests.'}</p></div><a class="storeBtn primary large" href="${esc(primaryTarget)}">${esc(primaryLabel)} <span aria-hidden="true">→</span></a></div>
    </section>
</main>
<footer class="storeFooter"><div class="storeWrap footerGrid"><div><a class="storeBrand footerBrand" href="/"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site)}</span></a><p>Simple streaming access, managed from one place.</p></div><div class="footerLinks"><div><strong>Account</strong><a href="/account/login">Customer sign in</a>${registrationOpen ? '<a href="/account/register">Create account</a>' : ''}</div><div><strong>Help</strong>${supportEmail ? `<a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>` : '<span>Contact your service administrator</span>'}</div></div></div><div class="storeWrap footerBottom"><span>© ${new Date().getFullYear()} ${esc(site)}</span><a href="/login">Administration</a></div></footer>
</body></html>`;
}

async function storefrontPage(req, res) {
    try {
        await runtimeSettings.ensureLoaded();
        const site = runtimeSettings.siteName ? runtimeSettings.siteName() : (process.env.SITE_NAME || 'CAPTAiNFiN');
        if (!runtimeSettings.storefrontEnabled()) {
            res.setHeader('Cache-Control', 'no-store, private, max-age=0');
            return res.status(404).send(disabledPage(site));
        }
        const [plans, store] = await Promise.all([customers.listPublicPlans(), settings()]);
        const registrationOpen = runtimeSettings.publicRegistrationOpen();
        const logged = Boolean(req.session?.customerId);
        res.setHeader('Cache-Control', logged ? 'no-store, private, max-age=0' : 'public, max-age=60');
        return res.send(renderStorefront({ site, plans, store, registrationOpen, logged }));
    } catch (error) {
        console.error('Storefront failed:', error.message);
        return res.status(500).send('Store temporarily unavailable');
    }
}

module.exports = {
    storefrontPage,
    settings,
    disabledPage,
    renderStorefront,
    planCard,
    planService,
    accessModel,
    savingForPlan,
    monthlyEquivalent,
    bestValueCode
};
