'use strict';

const core=require('./admin-html-core');
const notificationWorkflow=require('./notification-workflow-tabs');
const provisioningWorkflow=require('./provisioning-workflow-tabs');
const integrationWorkflow=require('./integration-workflow-tabs');
const backupWorkflow=require('./backup-workflow-tabs');

function scriptBoundary(ch){return ch===undefined||/[\s/>]/.test(ch);}
function externalScriptTag(openTag){return /\bsrc\s*=/i.test(openTag);}

// Admin body fragments are server-generated HTML with escaped dynamic values.
// Until the last legacy inline behaviours are physically removed from every
// fragment, discard inline script elements before rendering. External scripts
// remain allowed because the application CSP only permits same-origin scripts.
function stripInlineScripts(body){
    const html=String(body||'');
    const lower=html.toLowerCase();
    let cursor=0,out='';
    while(cursor<html.length){
        const start=lower.indexOf('<script',cursor);
        if(start<0){out+=html.slice(cursor);break;}
        if(!scriptBoundary(lower[start+7])){
            out+=html.slice(cursor,start+7);
            cursor=start+7;
            continue;
        }
        const openEnd=html.indexOf('>',start+7);
        if(openEnd<0){out+=html.slice(cursor,start);break;}
        const openTag=html.slice(start,openEnd+1);
        if(externalScriptTag(openTag)){
            out+=html.slice(cursor,openEnd+1);
            cursor=openEnd+1;
            continue;
        }
        const closeStart=lower.indexOf('</script',openEnd+1);
        if(closeStart<0){out+=html.slice(cursor,start);break;}
        const closeEnd=html.indexOf('>',closeStart+8);
        if(closeEnd<0){out+=html.slice(cursor,start);break;}
        out+=html.slice(cursor,start);
        cursor=closeEnd+1;
    }
    return out;
}

// Legacy compatibility only. New semantic field help belongs in the owning
// route/template/component (for example admin-setting-controls.field()).
// Entries should shrink as owning pages migrate; do not add new application
// behaviour here.
const SETTING_HELP=Object.freeze({
    'Hero title':'The main headline customers see at the top of the public storefront.',
    'Hero subtitle':'Short supporting copy that explains the service beneath the main storefront headline.',
    'Features heading':'Heading shown above the storefront feature list.',
    'Announcement':'Optional short message displayed prominently on the storefront.',
    'Features · one per line':'Each non-empty line becomes one public feature item.',
    'Site name':'The customer-facing platform name used in page titles, emails and portal branding.',
    'Username':'Portal username used for sign-in and administrative identification.',
    'Email':'Contact/login email for the account when email-based features are enabled.',
    'Name':'Human-readable name shown in administrator and customer-facing interfaces.',
    'Description':'Plain-language explanation of what this item or plan provides.',
    'Audience':'Direct customers is the only supported audience for this plan.',
    'Billing interval':'Commercial renewal cadence used by checkout and subscription workflows.',
    'Duration (days)':'Access period used when this plan creates a time-limited entitlement.',
    'Server class':'Default server pool class eligible to host customers on this plan.',
    'Sort order':'Controls relative display order; lower values appear earlier where sorting uses this field.',
    'Concurrent streams':'Maximum simultaneous playback sessions allowed by this plan policy. This does not consume server customer capacity.',
    'Price':'Catalogue price before any eligible discount or referral adjustment.',
    'Currency':'Three-letter ISO currency used for catalogue pricing and payment-provider validation.',
    'Stripe price ID':'Stripe-side recurring price or product mapping used for new Stripe checkouts.',
    'PayPal plan/product ID':'PayPal-side mapping used for new PayPal checkout or subscription flows.',
    'Base URL':'Internal service URL CAPTAiNFiN uses when making server-to-server requests.',
    'Public URL':'Externally reachable URL customers and playback clients should use.',
    'API key':'Credential CAPTAiNFiN uses for authenticated server-to-server requests. Treat it as a secret.',
    'Priority':'Placement preference used when more than one eligible server can host a customer.',
    'Max users':'Maximum managed customer users automatic placement may put on this server. Every customer counts once.',
    'SMTP host':'Mail server hostname used for transactional email delivery.',
    'SMTP port':'Mail server TCP port used by the configured SMTP security mode.',
    'From email':'Sender address customers see on transactional emails.',
    'From name':'Display name customers see alongside the transactional email sender address.',
    'Username / API key':'Authentication identity used by the integration when required.',
    'Retention days':'How long eligible records or backups are retained before automated cleanup.',
    'Public base URL':'Canonical HTTPS origin used to build customer-facing links and callbacks.',
    'Support email address':'Address shown to customers for account, service or legal support.',
    'Impact confirmation':'Safety confirmation required before changing a setting with live customer impact.'
});

function decorateSettingHelp(body){
    let html=String(body||'');
    for(const [label,help] of Object.entries(SETTING_HELP)){
        const marker=`<label>${label}</label>`;
        let cursor=0;
        while(true){
            const at=html.indexOf(marker,cursor);
            if(at<0)break;
            const after=at+marker.length;
            const groupEnd=html.indexOf('</div>',after);
            const scope=html.slice(after,groupEnd<0?Math.min(html.length,after+700):Math.min(groupEnd,after+700));
            if(!/(?:inlineHelp|fieldHelp|settings-hint)/.test(scope)){
                const addition=`<div class="fieldHelp">${core.esc(help)}</div>`;
                html=html.slice(0,after)+addition+html.slice(after);
                cursor=after+addition.length;
            }else cursor=after;
        }
    }
    return html;
}

function notificationTabsFor(options={}){
    const active=String(options.active||'');
    const title=String(options.title||'');
    const subtitle=String(options.subtitle||'');
    if(active==='my-profile')return notificationWorkflow.profileTabs('profile');
    if(active==='my-notifications'||title==='My notification preferences')return notificationWorkflow.profileTabs('personal');
    if(active==='notification-gateway')return notificationWorkflow.globalTabs('health');
    if(!['notifications','notification-settings'].includes(active))return'';
    const context=`${title} ${subtitle}`;
    if(/transactional email gateway/i.test(context))return notificationWorkflow.globalTabs('email');
    if(/delivery health|notification gateway|delivery queue|outbox health/i.test(context))return notificationWorkflow.globalTabs('health');
    return notificationWorkflow.globalTabs('global');
}

function provisioningTabsFor(options={}){
    const active=String(options.active||'');
    const tab={provisioning:'provisioning','server-migrations':'migrations','policy-drift':'drift'}[active];
    return tab?provisioningWorkflow.tabs(tab):'';
}
function integrationTabsFor(options={}){
    const active=String(options.active||'');
    const tab={'settings-integrations':'integrations','request-service':'requests'}[active];
    return tab?integrationWorkflow.tabs(tab):'';
}
function backupTabsFor(options={}){
    const active=String(options.active||'');
    if(active==='backups')return backupWorkflow.tabs('backups');
    if(active==='configuration-transfer')return backupWorkflow.tabs('transfer');
    return'';
}

// Compatibility cleanup for retired admin destinations. Old source fragments or
// extensions may still emit the former standalone request-policy URL; the
// canonical owner is Commerce -> Plans, so never render the ghost workflow.
function canonicalizeRetiredAdminDestinations(body){
    let html=String(body||'');
    html=html.replace(/href=(["'])\/admin\/request-plan-policy\1/g,(_match,quote)=>`href=${quote}/admin/plans${quote}`);
    html=html.replace(/<strong>Request limits<\/strong><span>Movie and TV quotas for the request service<\/span>/g,'<strong>Plan request policies</strong><span>Quotas and Jellyseerr permissions are configured on each plan.</span>');
    return html;
}

function notificationTestScriptFor(options={}){
    return String(options.title||'')==='My notification preferences'?'<script src="/js/admin-personal-notification-tests.js" defer></script>':'';
}
function planWorkflowScriptFor(options={}){
    return String(options.active||'')==='plans'?'<script src="/js/admin-plan-workflow.js" defer></script>':'';
}
function discountScriptFor(options={}){
    return String(options.active||'')==='discounts'?'<script src="/js/admin-discounts.js" defer></script>':'';
}

function layout(options={}){
    const workflow=notificationTabsFor(options)+provisioningTabsFor(options)+integrationTabsFor(options)+backupTabsFor(options);
    const scripts=notificationTestScriptFor(options)+planWorkflowScriptFor(options)+discountScriptFor(options)+'<script src="/js/operator-business-indicators.js" defer></script><script src="/js/admin-customer-operator.js" defer></script>';
    const canonicalBody=canonicalizeRetiredAdminDestinations(options.body);
    options={...options,body:workflow+canonicalBody+scripts};
    const safeBody=stripInlineScripts(options.body);
    return core.layout({...options,body:decorateSettingHelp(safeBody)});
}

module.exports={...core,layout,stripInlineScripts,decorateSettingHelp,notificationTabsFor,provisioningTabsFor,integrationTabsFor,backupTabsFor,canonicalizeRetiredAdminDestinations,notificationTestScriptFor,planWorkflowScriptFor,discountScriptFor,SETTING_HELP};
