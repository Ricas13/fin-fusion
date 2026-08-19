'use strict';

const DOMAINS=Object.freeze([
  Object.freeze({key:'general',label:'General & branding',href:'/admin/settings?section=general',scope:'platform',description:'Site name, storefront publishing, public URL, locale, timezone and support links.'}),
  Object.freeze({key:'plans',label:'Plans & customer access',href:'/admin/plans',scope:'plan',description:'What customers buy or claim: service type, prices, access rules, Jellyfin policy, libraries, availability and storefront order.'}),
  Object.freeze({key:'servers',label:'Jellyfin servers',href:'/admin/servers',scope:'server',description:'Server connection, health, class, capacity, placement and controlled customer moves.'}),
  Object.freeze({key:'stremio',label:'Stremio',href:'/admin/servers/stremio',scope:'service',description:'Stremio source connections, library selection, indexing, runtime readiness and delivery.'}),
  Object.freeze({key:'communications',label:'Communications',href:'/admin/notifications/preferences',scope:'platform/customer/admin',description:'Email infrastructure, Telegram, Discord, WhatsApp, event permissions and notification choices.'}),
  Object.freeze({key:'security',label:'Customer onboarding & security',href:'/admin/settings?section=security',scope:'platform',description:'Registration, email verification policy, sessions, administrator 2FA, Turnstile and trusted network destinations.'}),
  Object.freeze({key:'automation',label:'Automation',href:'/admin/automation',scope:'platform/customer',description:'Worker health, scheduled jobs, retention, provisioning retries and automated cleanup.'}),
  Object.freeze({key:'commerce',label:'Commerce',href:'/admin/commerce',scope:'platform/plan/customer',description:'Payment providers, billing incidents, discounts, reporting and affiliate service credit.'}),
  Object.freeze({key:'customer',label:'Individual customer overrides',href:'/admin/users',scope:'customer',description:'Customer plan, Jellyfin placement, expiry, verification, automation protection, provisioning, libraries and technical policy overrides.'}),
  Object.freeze({key:'backups',label:'Backups & configuration',href:'/admin/backups',scope:'platform',description:'Backups, restore readiness and configuration transfer.'})
]);

const SETTINGS=Object.freeze([
  {key:'platform.siteName',owner:'general',label:'Site name'},
  {key:'platform.storefrontEnabled',owner:'general',label:'Public storefront'},
  {key:'operations.publicBaseUrl',owner:'general',label:'Public base URL'},
  {key:'operations.locale',owner:'general',label:'Locale'},
  {key:'operations.timezone',owner:'general',label:'Timezone'},
  {key:'plan.serviceType',owner:'plans',label:'Plan service type'},
  {key:'plan.pricing',owner:'plans',label:'Plan pricing'},
  {key:'plan.jellyfinPolicy',owner:'plans',label:'Jellyfin plan policy'},
  {key:'plan.libraryPolicy',owner:'plans',label:'Plan libraries'},
  {key:'plan.placement',owner:'plans',label:'Plan server placement'},
  {key:'plan.availability',owner:'plans',label:'Plan availability'},
  {key:'server.connection',owner:'servers',label:'Jellyfin connection'},
  {key:'server.capacity',owner:'servers',label:'Jellyfin server capacity'},
  {key:'stremio.sources',owner:'stremio',label:'Stremio sources'},
  {key:'stremio.indexing',owner:'stremio',label:'Stremio indexing'},
  {key:'notification.channels',owner:'communications',label:'Notification channels'},
  {key:'notification.customerEvents',owner:'communications',label:'Customer notification events'},
  {key:'security.registration',owner:'security',label:'Public registration'},
  {key:'security.emailVerification',owner:'security',label:'Email verification requirement'},
  {key:'security.sessions',owner:'security',label:'Session lifetime'},
  {key:'security.admin2fa',owner:'security',label:'Administrator 2FA policy'},
  {key:'security.turnstile',owner:'security',label:'Turnstile'},
  {key:'automation.jobs',owner:'automation',label:'Automation jobs'},
  {key:'automation.cleanup',owner:'automation',label:'Automated cleanup'},
  {key:'commerce.providers',owner:'commerce',label:'Payment providers'},
  {key:'commerce.affiliates',owner:'commerce',label:'Affiliate service credit'},
  {key:'customer.emailVerified',owner:'customer',label:'Manual email verification'},
  {key:'customer.plan',owner:'customer',label:'Customer plan override'},
  {key:'customer.server',owner:'customer',label:'Customer server assignment'},
  {key:'customer.expiry',owner:'customer',label:'Customer access expiry'},
  {key:'customer.cleanupProtection',owner:'customer',label:'Customer automation protection'},
  {key:'customer.jellyfinPolicy',owner:'customer',label:'Customer Jellyfin policy override'},
  {key:'customer.libraries',owner:'customer',label:'Customer library override'}
].map(Object.freeze));

function domains(){return DOMAINS.slice();}
function domain(key){return DOMAINS.find(item=>item.key===key)||null;}
function setting(key){return SETTINGS.find(item=>item.key===key)||null;}
function ownerForSetting(key){const item=setting(key);return item?domain(item.owner):null;}
function search(term){const q=String(term||'').trim().toLowerCase();if(!q)return[];return SETTINGS.map(item=>({...item,domain:domain(item.owner)})).filter(item=>[item.key,item.label,item.domain?.label,item.domain?.description].filter(Boolean).join(' ').toLowerCase().includes(q));}
function directoryCards(esc){const e=typeof esc==='function'?esc:(v=>String(v));return DOMAINS.map(item=>`<a class="quick-action" href="${e(item.href)}" data-setting-domain="${e(item.key)}"><strong>${e(item.label)}</strong><span>${e(item.description)}</span></a>`).join('');}

module.exports={DOMAINS,SETTINGS,domains,domain,setting,ownerForSetting,search,directoryCards};
