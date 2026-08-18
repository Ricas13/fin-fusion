'use strict';

const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const providerSettings=require('../payments/provider-settings');
const requestServiceSettings=require('../integrations/request-service-settings');
const emailSettings=require('../integrations/email-settings');

async function setupReadiness(){
  await Promise.all([runtimeSettings.ensureLoaded(),providerSettings.ensureLoaded(),requestServiceSettings.ensureLoaded().catch(()=>{})]);
  const[counts,directMappings,resellerMappings,settings,activeDiscounts,stripeStatus,paypalStatus,requestStatus,emailStatus,automation]=await Promise.all([
    query(`SELECT
      (SELECT COUNT(*)::int FROM jellyfin_servers) servers,
      (SELECT COUNT(*)::int FROM plans) plans,
      (SELECT COUNT(*)::int FROM plans WHERE COALESCE(is_free_tier,FALSE)=FALSE AND archived_at IS NULL) configured_customer_plans,
      (SELECT COUNT(*)::int FROM plans WHERE is_free_tier=TRUE) free_tiers,
      (SELECT COUNT(*)::int FROM reseller_tiers WHERE active=TRUE AND visible=TRUE) reseller_plans,
      (SELECT COUNT(*)::int FROM resellers) resellers,
      (SELECT COUNT(*)::int FROM customers) customers,
      (SELECT COUNT(*)::int FROM affiliate_profiles WHERE active=TRUE) affiliates,
      (SELECT COUNT(*)::int FROM subscriptions) subscriptions`),
    query(`SELECT pp.provider,COUNT(*)::int mappings FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id WHERE pp.active=TRUE AND p.active=TRUE AND p.audience IN('direct','both') GROUP BY pp.provider`),
    query(`SELECT rp.provider,COUNT(*)::int mappings FROM reseller_tier_provider_prices rp JOIN reseller_tiers rt ON rt.id=rp.tier_id WHERE rp.active=TRUE AND rt.active=TRUE AND rt.visible=TRUE GROUP BY rp.provider`),
    query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key IN('affiliate_program','installation')`),
    query(`SELECT COUNT(*)::int count FROM discount_codes WHERE active=TRUE`),
    providerSettings.status('stripe'),providerSettings.status('paypal'),
    requestServiceSettings.status().catch(()=>({enabled:false,configured:false,baseUrl:''})),
    emailSettings.status(),
    query(`SELECT COUNT(*) FILTER(WHERE enabled=TRUE)::int enabled,COUNT(*) FILTER(WHERE last_error IS NOT NULL)::int errors,MAX(last_success_at)last_success FROM automation_job_state`)
  ]);
  const c=counts.rows[0]||{},direct=Object.fromEntries(directMappings.rows.map(r=>[r.provider,Number(r.mappings||0)])),reseller=Object.fromEntries(resellerMappings.rows.map(r=>[r.provider,Number(r.mappings||0)])),settingMap=Object.fromEntries(settings.rows.map(r=>[r.setting_key,r.setting_value||{}]));
  const stripeConfigured=Boolean(stripeStatus.configured),paypalConfigured=Boolean(paypalStatus.configured),directStripe=stripeConfigured&&Number(direct.stripe||0)>0,directPayPal=paypalConfigured&&Number(direct.paypal||0)>0,resellerStripe=stripeConfigured&&Number(reseller.stripe||0)>0,resellerPayPal=paypalConfigured&&Number(reseller.paypal||0)>0;
  const emailReady=Boolean(emailStatus.configured),telegramReady=Boolean(String(process.env.TELEGRAM_BOT_TOKEN||'').trim()&&String(process.env.TELEGRAM_CHAT_ID||'').trim()),notificationsReady=emailReady||telegramReady,storefrontEnabled=runtimeSettings.storefrontEnabled(),registrationEnabled=runtimeSettings.publicRegistrationOpen(),affiliatesEnabled=settingMap.affiliate_program?.enabled===true,requestReady=Boolean(requestStatus.configured),auto=automation.rows[0]||{},configuredCustomerPlans=Number(c.configured_customer_plans||0),freeTiers=Number(c.free_tiers||0),resellerPlans=Number(c.reseller_plans||0),resellerCount=Number(c.resellers||0),affiliateCount=Number(c.affiliates||0);
  const checklist=[
    {key:'jellyfin',label:'Add first Jellyfin server',configured:Number(c.servers||0)>0,detail:Number(c.servers||0)>0?`${c.servers} server${Number(c.servers)===1?'':'s'} configured`:'Optional until you are ready to provision users',href:'/admin/servers/new'},
    {key:'plans',label:'Configure customer plans',configured:configuredCustomerPlans>0,detail:configuredCustomerPlans>0?`${configuredCustomerPlans} customer plan${configuredCustomerPlans===1?'':'s'} configured${freeTiers?` · Free Access also present`:''}`:freeTiers?'Free Access exists but the customer catalogue still needs configuration':'No customer plans yet',href:'/admin/plans'},
    {key:'direct-payments',label:'Configure customer commerce',configured:directStripe||directPayPal,detail:directStripe||directPayPal?[directStripe?'Stripe':null,directPayPal?'PayPal':null].filter(Boolean).join(' + ')+' mapped to customer plans':'Optional · provider credentials plus a customer-plan payment mapping',href:'/admin/payments'},
    {key:'reseller-plans',label:'Configure reseller plans',configured:resellerPlans>0,detail:resellerPlans>0?`${resellerPlans} monthly reseller plan${resellerPlans===1?'':'s'} configured`:'Optional · define managed-user allowance and Jellyfin policy in Plans',href:'/admin/plans'},
    {key:'reseller-payments',label:'Configure reseller commerce',configured:resellerStripe||resellerPayPal,detail:resellerStripe||resellerPayPal?[resellerStripe?'Stripe':null,resellerPayPal?'PayPal':null].filter(Boolean).join(' + ')+' mapped to reseller plans':'Optional · provider credentials plus a reseller-plan recurring payment mapping',href:'/admin/payments'},
    {key:'affiliates',label:'Configure affiliate programme',configured:affiliatesEnabled,detail:affiliatesEnabled?`Enabled · ${affiliateCount} active affiliate account${affiliateCount===1?'':'s'}`:'Optional · enable reward percentage and qualification rules when you want referrals',href:'/admin/referrals'},
    {key:'requests',label:'Configure request service',configured:requestReady,detail:requestReady?`Central request service ready · ${requestStatus.baseUrl}`:'Optional · configure Seerr/Overseerr in Settings → Integrations',href:'/admin/request-users'},
    {key:'email',label:'Configure transactional email',configured:emailReady,detail:emailReady?`SMTP ready · ${emailStatus.source==='browser'?'browser managed':'environment fallback'}`:'Optional, but required for automatic activation/password-reset delivery',href:'/admin/notifications'},
    {key:'notifications',label:'Configure notification delivery',configured:notificationsReady,detail:notificationsReady?[telegramReady?'Telegram':null,emailReady?'Email':null].filter(Boolean).join(' + '):'Optional · no implemented delivery channel configured',href:'/admin/notifications'},
    {key:'automation',label:'Start automation worker',configured:Boolean(auto.last_success),detail:auto.last_success?`${Number(auto.enabled||0)} jobs enabled · last success ${new Date(auto.last_success).toLocaleString()}`:`${Number(auto.enabled||0)} jobs configured · waiting for first successful worker run`,href:'/admin/automation'},
    {key:'storefront',label:'Configure storefront / registration',configured:storefrontEnabled||registrationEnabled,detail:storefrontEnabled?`Storefront enabled · registration ${registrationEnabled?'open':'closed'}`:`Storefront disabled · registration ${registrationEnabled?'open':'closed'}`,href:'/admin/settings'}
  ];
  const modules=[
    {name:'Customers',state:'enabled',detail:`${Number(c.customers||0)} customers`},
    {name:'Resellers',state:resellerPlans>0?'configured':'not_configured',detail:resellerPlans>0?`${resellerPlans} plans · ${resellerCount} accounts`:'Optional monthly-seat product'},
    {name:'Affiliates',state:affiliatesEnabled?'enabled':'disabled',detail:affiliatesEnabled?`${affiliateCount} active`:'Opt-in'},
    {name:'Jellyfin',state:Number(c.servers||0)>0?'configured':'not_configured',detail:`${Number(c.servers||0)} servers`},
    {name:'Customer commerce',state:directStripe||directPayPal?'configured':'not_configured',detail:[directStripe?'Stripe':null,directPayPal?'PayPal':null].filter(Boolean).join(' + ')||'Optional'},
    {name:'Reseller commerce',state:resellerStripe||resellerPayPal?'configured':'not_configured',detail:[resellerStripe?'Stripe':null,resellerPayPal?'PayPal':null].filter(Boolean).join(' + ')||'Optional'},
    {name:'Request service',state:requestStatus.enabled?(requestReady?'configured':'not_configured'):'disabled',detail:requestReady?requestStatus.baseUrl:'Optional'},
    {name:'Email',state:emailStatus.enabled?(emailReady?'configured':'not_configured'):'disabled',detail:emailReady?`${emailStatus.host}:${emailStatus.port}`:'Optional'},
    {name:'Storefront',state:storefrontEnabled?'enabled':'disabled',detail:storefrontEnabled?'Public homepage enabled':'Opt-in'},
    {name:'Registration',state:registrationEnabled?'enabled':'disabled',detail:registrationEnabled?'Public registration open':'Invite/admin onboarding only'},
    {name:'Notifications',state:notificationsReady?'configured':'not_configured',detail:notificationsReady?[telegramReady?'Telegram':null,emailReady?'Email':null].filter(Boolean).join(' + '):'Optional'},
    {name:'Discounts',state:Number(activeDiscounts.rows[0]?.count||0)>0?'enabled':'available',detail:`${Number(activeDiscounts.rows[0]?.count||0)} active`},
    {name:'Automation',state:Number(auto.errors||0)>0?'degraded':auto.last_success?'configured':'not_configured',detail:`${Number(auto.enabled||0)} enabled · ${Number(auto.errors||0)} errors`}
  ];
  return{checklist,configuredCount:checklist.filter(i=>i.configured).length,totalCount:checklist.length,modules,counts:{servers:Number(c.servers||0),plans:Number(c.plans||0),configuredCustomerPlans,freeTiers,resellerPlans,resellers:resellerCount,customers:Number(c.customers||0),affiliates:affiliateCount,subscriptions:Number(c.subscriptions||0)},cleanInstall:settingMap.installation?.cleanInstall===true};
}
module.exports={setupReadiness};
