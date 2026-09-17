'use strict';

const DOMAINS=Object.freeze([
  Object.freeze({key:'general',label:'General & branding',href:'/admin/settings?section=general',scope:'platform',description:'Site name, storefront publishing, portal currency, public URL, locale, timezone, branding and support links.'}),
  Object.freeze({key:'plans',label:'Plans & customer access',href:'/admin/plans',scope:'plan',description:'What customers buy or claim: service type, prices, access rules, Jellyfin policy, libraries, availability and storefront order.'}),
  Object.freeze({key:'servers',label:'Jellyfin servers',href:'/admin/servers',scope:'server',description:'Server connection, health, capacity, placement, Free Server inactivity rules, libraries and controlled customer moves.'}),
  Object.freeze({key:'stremio',label:'Stremio',href:'/admin/servers/stremio',scope:'service',description:'Stremio source connections, library selection, indexing, runtime readiness and delivery.'}),
  Object.freeze({key:'communications',label:'Communications',href:'/admin/settings/integrations',scope:'platform/customer/admin',description:'Email infrastructure, Telegram, Discord, request service, event permissions and notification choices.'}),
  Object.freeze({key:'security',label:'Customer onboarding & security',href:'/admin/settings?section=security',scope:'platform',description:'Registration, email verification policy, sessions, administrator 2FA, Turnstile and trusted network destinations.'}),
  Object.freeze({key:'automation',label:'Automation & recovery',href:'/admin/automation',scope:'platform/customer',description:'Worker health, scheduled jobs, provisioning retries, access consistency and lifecycle automation.'}),
  Object.freeze({key:'commerce',label:'Commerce & billing',href:'/admin/commerce',scope:'platform/plan/customer',description:'Orders, billing integrity, payment providers, transaction history, discounts, profitability and affiliate service credit.'}),
  Object.freeze({key:'customer',label:'Individual customer controls',href:'/admin/users',scope:'customer',description:'Customer plan, Jellyfin placement, expiry/permanent access, verification, automation protection, provisioning, libraries and technical overrides.'}),
  Object.freeze({key:'backups',label:'Backups & configuration',href:'/admin/backups',scope:'platform',description:'Backups, restore readiness, data export and configuration transfer.'})
]);

const SETTINGS=Object.freeze([
  {key:'platform.siteName',owner:'general',label:'Site name',keywords:'brand portal name'},
  {key:'platform.storefrontEnabled',owner:'general',label:'Public storefront',keywords:'homepage publish website'},
  {key:'platform.currency',owner:'general',label:'Portal currency',href:'/admin/settings/currency',keywords:'currency money price pricing gbp usd eur master reporting'},
  {key:'operations.publicBaseUrl',owner:'general',label:'Public base URL',keywords:'domain callback external url'},
  {key:'operations.locale',owner:'general',label:'Locale',keywords:'region language formatting'},
  {key:'operations.timezone',owner:'general',label:'Timezone',keywords:'time zone dates'},
  {key:'platform.branding',owner:'general',label:'Logo and favicon',href:'/admin/settings/branding',keywords:'branding logo icon favicon'},
  {key:'platform.support',owner:'general',label:'Support, documentation and legal links',href:'/admin/settings/support',keywords:'support discord docs gitbook status refund terms privacy vat business address'},

  {key:'plan.serviceType',owner:'plans',label:'Plan service type',keywords:'jellyfin stremio bundle product'},
  {key:'plan.pricing',owner:'plans',label:'Plan pricing',keywords:'price currency stripe paypal'},
  {key:'plan.jellyfinPolicy',owner:'plans',label:'Jellyfin plan policy',keywords:'streams concurrent downloads transcode transcoding remux live tv 4k remote access'},
  {key:'plan.libraryPolicy',owner:'plans',label:'Plan libraries',keywords:'library libraries 1080p 4k access content'},
  {key:'plan.placement',owner:'plans',label:'Plan server placement',keywords:'server assignment placement fleet'},
  {key:'plan.availability',owner:'plans',label:'Plan availability',keywords:'capacity places spots sold out inventory'},
  {key:'plan.accessRules',owner:'plans',label:'Trial and Free access rules',href:'/admin/plans/access-rules',keywords:'trial eligibility free claim paid downgrade lifecycle'},
  {key:'plan.storefrontOrder',owner:'plans',label:'Storefront plan order',href:'/admin/plans/order',keywords:'sort order homepage cards storefront position'},

  {key:'server.connection',owner:'servers',label:'Jellyfin connection',keywords:'url api key credentials health'},
  {key:'server.capacity',owner:'servers',label:'Jellyfin server capacity',keywords:'max users limit places spots occupancy'},
  {key:'server.placement',owner:'servers',label:'Jellyfin placement mode',keywords:'active drain maintenance allow new users priority'},
  {key:'server.freeInactivity',owner:'servers',label:'Free Server inactivity policy',href:'/admin/servers',keywords:'free user inactivity inactive cleanup remove first playback grace rolling playback window minimum minutes usage policy per server'},
  {key:'server.libraries',owner:'servers',label:'Jellyfin libraries',href:'/admin/libraries',keywords:'library scan inventory media counts'},
  {key:'server.customerMoves',owner:'servers',label:'Move customers between Jellyfin servers',href:'/admin/provisioning/migrations',keywords:'move migrate migration server assignment rollback customer'},
  {key:'server.accessConsistency',owner:'servers',label:'Jellyfin access consistency',href:'/admin/provisioning/drift',keywords:'drift reconciliation expected actual permissions repair'},

  {key:'stremio.sources',owner:'stremio',label:'Stremio sources',keywords:'jellyfin source url account token'},
  {key:'stremio.indexing',owner:'stremio',label:'Stremio indexing',keywords:'catalogue catalog refresh index titles'},
  {key:'stremio.household',owner:'stremio',label:'Stremio household IP access',href:'/admin/stremio/playback',keywords:'household ip lease network access'},

  {key:'notification.channels',owner:'communications',label:'Notification channels',href:'/admin/notifications/preferences',keywords:'telegram discord messaging events preferences'},
  {key:'notification.customerEvents',owner:'communications',label:'Customer notification events',href:'/admin/notifications/preferences',keywords:'customer alerts messages preferences'},
  {key:'notification.email',owner:'communications',label:'Transactional email / SMTP',href:'/admin/notifications/email',keywords:'smtp email verification password reset queue gateway'},
  {key:'integration.requestService',owner:'communications',label:'Request service / Jellyseerr',href:'/admin/request-users',keywords:'overseerr seerr jellyseerr request api key sync users'},
  {key:'integration.requestPolicy',owner:'communications',label:'Request quotas and permissions',href:'/admin/request-plan-policy',keywords:'movie tv quota permissions jellyseerr plan'},

  {key:'security.registration',owner:'security',label:'Public registration',keywords:'signup sign up customer create'},
  {key:'security.emailVerification',owner:'security',label:'Email verification requirement',keywords:'confirm verify verified email'},
  {key:'security.sessions',owner:'security',label:'Session lifetime',keywords:'login expiry logout cookie'},
  {key:'security.admin2fa',owner:'security',label:'Administrator 2FA policy',href:'/admin/settings/admin-2fa',keywords:'two factor totp authenticator admin staff'},
  {key:'security.turnstile',owner:'security',label:'Turnstile and abuse protection',href:'/admin/settings/abuse-protection',keywords:'captcha cloudflare bot spam abuse protection'},
  {key:'security.trustedNetwork',owner:'security',label:'Trusted integration hosts and CIDRs',keywords:'private lan outbound hostname cidr network'},

  {key:'automation.jobs',owner:'automation',label:'Automation jobs',href:'/admin/automation',keywords:'scheduler worker cron tasks queue jobs'},
  {key:'automation.provisioning',owner:'automation',label:'Provisioning recovery',href:'/admin/provisioning',keywords:'reconcile retry failed blocked access delivery'},
  {key:'automation.accessConsistency',owner:'automation',label:'Access consistency checks',href:'/admin/provisioning/drift',keywords:'drift expected actual jellyfin policy repair'},
  {key:'automation.activationCleanup',owner:'automation',label:'Abandoned activation cleanup',href:'/admin/settings?section=security',keywords:'delete abandoned registration portal activation cleanup retention'},
  {key:'automation.audit',owner:'automation',label:'Audit and incident history',href:'/admin/events',keywords:'audit log events history investigate failures'},

  {key:'commerce.orders',owner:'commerce',label:'Orders and renewals',href:'/admin/commerce/orders',keywords:'purchases order renewals expiry revenue'},
  {key:'commerce.billing',owner:'commerce',label:'Billing integrity',href:'/admin/billing',keywords:'missing provider link recurring subscription past due discovery reconcile'},
  {key:'commerce.providers',owner:'commerce',label:'Payment provider settings',href:'/admin/payments',keywords:'stripe paypal plisio webhook callback checkout credentials gateway'},
  {key:'commerce.transactions',owner:'commerce',label:'Provider transaction ledger',href:'/admin/payments/transactions',keywords:'transaction history stripe paypal fees provider id archive'},
  {key:'commerce.reconciliation',owner:'commerce',label:'Unmapped provider payments',href:'/admin/payments/reconciliation',keywords:'missing payment unmapped stripe paypal reconciliation money'},
  {key:'commerce.expenses',owner:'commerce',label:'Expenses and profitability',href:'/admin/expenses',keywords:'profit loss costs hosting software expenses finance'},
  {key:'commerce.discounts',owner:'commerce',label:'Discount codes and campaigns',href:'/admin/discounts',keywords:'coupon promo promotion marketing campaign email'},
  {key:'commerce.affiliates',owner:'commerce',label:'Affiliate service credit',href:'/admin/referrals',keywords:'referral affiliate credits reward'},
  {key:'commerce.refunds',owner:'commerce',label:'Prepaid refund policy',href:'/admin/refunds',keywords:'refund prepaid prorata policy'},
  {key:'commerce.providerMappings',owner:'commerce',label:'Provider plan mappings',href:'/admin/provider-mappings',keywords:'stripe paypal mapping plan price provider'},

  {key:'customer.emailVerified',owner:'customer',label:'Manual email verification',keywords:'confirm customer email override'},
  {key:'customer.plan',owner:'customer',label:'Customer plan change',keywords:'change plan subscription customer access'},
  {key:'customer.server',owner:'customer',label:'Customer Jellyfin server assignment',keywords:'move migrate assign jellyfin server'},
  {key:'customer.expiry',owner:'customer',label:'Customer access expiry',keywords:'expiration end date extend'},
  {key:'customer.permanentAccess',owner:'customer',label:'Permanent customer access',keywords:'lifetime never expire permanent vip'},
  {key:'customer.cleanupProtection',owner:'customer',label:'Customer automation protection',keywords:'never delete inactivity cleanup protected'},
  {key:'customer.jellyfinPassword',owner:'customer',label:'Customer Jellyfin password support',href:'/admin/customer-jellyfin-password',keywords:'reset password credentials jellyfin'},
  {key:'customer.jellyfinPolicy',owner:'customer',label:'Customer Jellyfin policy override',keywords:'streams concurrent downloads transcode transcoding remux live tv 4k remote access override'},
  {key:'customer.libraries',owner:'customer',label:'Customer library override',keywords:'grant revoke libraries 1080p 4k'},
  {key:'customer.holds',owner:'customer',label:'Customer access holds and suspension',keywords:'ban suspend remove access release hold'},

  {key:'backup.schedule',owner:'backups',label:'Backup schedule and retention',href:'/admin/backups',keywords:'backup recovery retention copies verify schedule'},
  {key:'backup.export',owner:'backups',label:'Data export',href:'/admin/payments/export',keywords:'export portability data archive'},
  {key:'backup.configurationTransfer',owner:'backups',label:'Configuration transfer',href:'/admin/configuration',keywords:'configuration export import transfer migration'}
].map(Object.freeze));

function domains(){return DOMAINS.slice();}
function domain(key){return DOMAINS.find(item=>item.key===key)||null;}
function setting(key){return SETTINGS.find(item=>item.key===key)||null;}
function ownerForSetting(key){const item=setting(key);return item?domain(item.owner):null;}
function resultDomain(item){const owner=domain(item.owner);return owner&&item.href?{...owner,href:item.href}:owner;}
function search(term){
  const q=String(term||'').trim().toLowerCase();
  if(!q)return[];
  return SETTINGS.map(item=>({...item,domain:resultDomain(item)}))
    .filter(item=>[item.key,item.label,item.keywords,item.domain?.label,item.domain?.description].filter(Boolean).join(' ').toLowerCase().includes(q));
}
function directoryCards(esc){
  const e=typeof esc==='function'?esc:(v=>String(v));
  return DOMAINS.map(item=>`<a class="quick-action" href="${e(item.href)}" data-setting-domain="${e(item.key)}"><strong>${e(item.label)}</strong><span>${e(item.description)}</span></a>`).join('');
}

module.exports={DOMAINS,SETTINGS,domains,domain,setting,ownerForSetting,search,directoryCards};
