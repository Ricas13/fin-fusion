'use strict';

const DOMAINS=Object.freeze([
  Object.freeze({key:'general',label:'General & branding',href:'/admin/settings?section=general',scope:'platform',description:'Site name, storefront publishing, portal currency, public URL, locale, timezone and support links.'}),
  Object.freeze({key:'plans',label:'Plans & customer access',href:'/admin/plans',scope:'plan',description:'What customers buy or claim: service type, prices, access rules, Jellyfin policy, libraries, availability and storefront order.'}),
  Object.freeze({key:'servers',label:'Jellyfin servers',href:'/admin/servers',scope:'server',description:'Server connection, health, capacity, placement and controlled customer moves.'}),
  Object.freeze({key:'stremio',label:'Stremio',href:'/admin/servers/stremio',scope:'service',description:'Stremio source connections, library selection, indexing, runtime readiness and delivery.'}),
  Object.freeze({key:'communications',label:'Communications',href:'/admin/notifications/preferences',scope:'platform/customer/admin',description:'Email infrastructure, Telegram, Discord, event permissions and notification choices.'}),
  Object.freeze({key:'security',label:'Customer onboarding & security',href:'/admin/settings?section=security',scope:'platform',description:'Registration, email verification policy, sessions, administrator 2FA, Turnstile and trusted network destinations.'}),
  Object.freeze({key:'automation',label:'Automation',href:'/admin/automation',scope:'platform/customer',description:'Worker health, scheduled jobs, retention, provisioning retries and automated cleanup.'}),
  Object.freeze({key:'commerce',label:'Commerce',href:'/admin/commerce',scope:'platform/plan/customer',description:'Payment providers, billing incidents, discounts, reporting and affiliate service credit.'}),
  Object.freeze({key:'customer',label:'Individual customer overrides',href:'/admin/users',scope:'customer',description:'Customer plan, Jellyfin placement, expiry/permanent access, verification, automation protection, provisioning, libraries and technical policy overrides.'}),
  Object.freeze({key:'backups',label:'Backups & configuration',href:'/admin/backups',scope:'platform',description:'Backups, restore readiness and configuration transfer.'})
]);

const SETTINGS=Object.freeze([
  {key:'platform.siteName',owner:'general',label:'Site name',keywords:'brand portal name'},
  {key:'platform.storefrontEnabled',owner:'general',label:'Public storefront',keywords:'homepage publish website'},
  {key:'platform.currency',owner:'general',label:'Portal currency',href:'/admin/settings/currency',keywords:'currency money price pricing gbp usd eur master reporting'},
  {key:'operations.publicBaseUrl',owner:'general',label:'Public base URL',keywords:'domain callback external url'},
  {key:'operations.locale',owner:'general',label:'Locale',keywords:'region language formatting'},
  {key:'operations.timezone',owner:'general',label:'Timezone',keywords:'time zone dates'},
  {key:'plan.serviceType',owner:'plans',label:'Plan service type',keywords:'jellyfin stremio bundle product'},
  {key:'plan.pricing',owner:'plans',label:'Plan pricing',keywords:'price currency stripe paypal'},
  {key:'plan.jellyfinPolicy',owner:'plans',label:'Jellyfin plan policy',keywords:'streams concurrent downloads transcode transcoding remux live tv 4k remote access'},
  {key:'plan.libraryPolicy',owner:'plans',label:'Plan libraries',keywords:'library libraries 1080p 4k access content'},
  {key:'plan.placement',owner:'plans',label:'Plan server placement',keywords:'server assignment placement fleet'},
  {key:'plan.availability',owner:'plans',label:'Plan availability',keywords:'capacity places spots sold out inventory'},
  {key:'server.connection',owner:'servers',label:'Jellyfin connection',keywords:'url api key credentials health'},
  {key:'server.capacity',owner:'servers',label:'Jellyfin server capacity',keywords:'max users limit places spots occupancy'},
  {key:'stremio.sources',owner:'stremio',label:'Stremio sources',keywords:'jellyfin source url account token'},
  {key:'stremio.indexing',owner:'stremio',label:'Stremio indexing',keywords:'catalogue catalog refresh index titles'},
  {key:'notification.channels',owner:'communications',label:'Notification channels',keywords:'email telegram discord smtp'},
  {key:'notification.customerEvents',owner:'communications',label:'Customer notification events',keywords:'customer alerts messages preferences'},
  {key:'security.registration',owner:'security',label:'Public registration',keywords:'signup sign up customer create'},
  {key:'security.emailVerification',owner:'security',label:'Email verification requirement',keywords:'confirm verify verified email'},
  {key:'security.sessions',owner:'security',label:'Session lifetime',keywords:'login expiry logout cookie'},
  {key:'security.admin2fa',owner:'security',label:'Administrator 2FA policy',href:'/admin/settings/admin-2fa',keywords:'two factor totp authenticator admin staff'},
  {key:'security.turnstile',owner:'security',label:'Turnstile',href:'/admin/settings/abuse-protection',keywords:'captcha cloudflare bot spam abuse protection'},
  {key:'automation.jobs',owner:'automation',label:'Automation jobs',keywords:'scheduler worker cron tasks'},
  {key:'automation.cleanup',owner:'automation',label:'Automated cleanup',keywords:'delete inactive inactivity retention permanent protect'},
  {key:'commerce.providers',owner:'commerce',label:'Payment providers',href:'/admin/payments',keywords:'stripe paypal payment checkout billing'},
  {key:'commerce.affiliates',owner:'commerce',label:'Affiliate service credit',href:'/admin/referrals',keywords:'referral affiliate credits reward'},
  {key:'customer.emailVerified',owner:'customer',label:'Manual email verification',keywords:'confirm customer email override'},
  {key:'customer.plan',owner:'customer',label:'Customer plan override',keywords:'change plan customer access'},
  {key:'customer.server',owner:'customer',label:'Customer server assignment',keywords:'move migrate assign jellyfin server'},
  {key:'customer.expiry',owner:'customer',label:'Customer access expiry',keywords:'expiration end date extend'},
  {key:'customer.permanentAccess',owner:'customer',label:'Permanent customer access',keywords:'lifetime never expire permanent vip'},
  {key:'customer.cleanupProtection',owner:'customer',label:'Customer automation protection',keywords:'never delete inactivity cleanup protected'},
  {key:'customer.jellyfinPolicy',owner:'customer',label:'Customer Jellyfin policy override',keywords:'streams concurrent downloads transcode transcoding remux live tv 4k remote access override'},
  {key:'customer.libraries',owner:'customer',label:'Customer library override',keywords:'grant revoke libraries 1080p 4k'}
].map(Object.freeze));

function domains(){return DOMAINS.slice();}
function domain(key){return DOMAINS.find(item=>item.key===key)||null;}
function setting(key){return SETTINGS.find(item=>item.key===key)||null;}
function ownerForSetting(key){const item=setting(key);return item?domain(item.owner):null;}
function resultDomain(item){const owner=domain(item.owner);return owner&&item.href?{...owner,href:item.href}:owner;}
function search(term){const q=String(term||'').trim().toLowerCase();if(!q)return[];return SETTINGS.map(item=>({...item,domain:resultDomain(item)})).filter(item=>[item.key,item.label,item.keywords,item.domain?.label,item.domain?.description].filter(Boolean).join(' ').toLowerCase().includes(q));}
function directoryCards(esc){const e=typeof esc==='function'?esc:(v=>String(v));return DOMAINS.map(item=>`<a class="quick-action" href="${e(item.href)}" data-setting-domain="${e(item.key)}"><strong>${e(item.label)}</strong><span>${e(item.description)}</span></a>`).join('');}

module.exports={DOMAINS,SETTINGS,domains,domain,setting,ownerForSetting,search,directoryCards};
