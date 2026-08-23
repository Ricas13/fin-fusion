'use strict';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

(async () => {
    const currentPlan = { id:'plan-1',plan_id:'plan-1',name:'Monthly',code:'monthly',status:'active',source:'manual',current_period_end:new Date(Date.now()+86400000),streams:3,allow_downloads:true,allow_video_transcoding:false };
    const locals = {
        siteName:'Test Streams',
        portal:{customer:{login_username:'viewer1',display_name:'Viewer One'},subscriptions:[{plan_name:'Monthly',status:'active',current_period_end:currentPlan.current_period_end}],accounts:[{id:'account-1',jellyfin_username:'viewer1',disabled:false,server_name:'Primary',server_class:'premium',public_url:'https://jellyfin.example.test'}],providers:[],referralCode:'ABC123',referralsEnabled:true},
        currentPlan,
        plans:[{id:'plan-1',code:'monthly',name:'Monthly',billing_interval:'month',duration_days:30,price_minor:600,currency:'USD',description:'Monthly access',streams:3,allow_downloads:true,allow_video_transcoding:false,payment_options:[]},{id:'plan-2',code:'yearly',name:'Yearly',billing_interval:'year',duration_days:365,price_minor:5000,currency:'USD',description:'Yearly access',streams:3,allow_downloads:true,allow_video_transcoding:false,payment_options:[]}],
        stripeEnabled:false,paypalEnabled:false,plisioEnabled:false,overseerrUrl:null,requestAccess:null,requestSyncConfigured:false,libraryEntitlement:['Movies','TV'],librarySelection:['Movies'],provisioningState:{status:'healthy',last_error:null,next_attempt_at:null},hasJellyfin:true,hasStremio:false,deliveryType:'jellyfin',welcome:false,csrfToken:'csrf-test',message:null,error:null
    };

    const html=await ejs.renderFile(path.join(__dirname,'..','views','customer','dashboard.ejs'),locals);
    assert.match(html,/You're ready to watch/);assert.match(html,/Open Jellyfin/);assert.match(html,/View playback activity/);assert.match(html,/Manage my account/);assert.match(html,/Plan &amp; billing/);assert.match(html,/Libraries/);assert.match(html,/These choices only hide or show libraries already included in your plan/);assert.match(html,/Benefits/);assert.match(html,/\/account\/affiliate/);assert.match(html,/customerSidebar/);assert.match(html,/Jellyfin/);assert.doesNotMatch(html,/Welcome back, viewer1/,'Old dashboard-first greeting must not replace the action-first journey.');assert.doesNotMatch(html,/Refer a friend/,'Legacy referral-days copy must not reappear.');assert.match(html,/customer-portal\.css/);assert(!html.includes('Invalid Date'),'Portal must never render Invalid Date');assert.match(html,/Current/);

    const withSeerr=await ejs.renderFile(path.join(__dirname,'..','views','customer','dashboard.ejs'),{...locals,overseerrUrl:'https://requests.example.test',requestSyncConfigured:true,requestAccess:{external_user_id:'42',password_reset_required:false}});
    assert.match(withSeerr,/Sync portal password to Seerr/);assert.match(withSeerr,/currentPortalPassword/);assert.match(withSeerr,/plaintext password is not stored/);

    const pending=await ejs.renderFile(path.join(__dirname,'..','views','customer','dashboard.ejs'),{...locals,portal:{...locals.portal,accounts:[]},provisioningState:{status:'blocked',last_error:'No eligible Jellyfin server is currently available',next_attempt_at:new Date(Date.now()+600000)},welcome:true});
    assert.match(pending,/We are setting up your streaming access/);assert.match(pending,/No eligible Jellyfin server/);assert.match(pending,/Try setup again now/);assert.match(pending,/We're creating your Jellyfin account|Creating your account/);

    const readyWelcome=await ejs.renderFile(path.join(__dirname,'..','views','customer','dashboard.ejs'),{...locals,welcome:true});
    assert.match(readyWelcome,/Your streaming access is ready/);assert.match(readyWelcome,/https:\/\/jellyfin\.example\.test/);assert.match(readyWelcome,/viewer1/);assert.match(readyWelcome,/Open Jellyfin/);assert.match(readyWelcome,/Got it/);

    const empty=await ejs.renderFile(path.join(__dirname,'..','views','customer','dashboard.ejs'),{...locals,portal:{...locals.portal,subscriptions:[],accounts:[],referralCode:null,referralsEnabled:false},currentPlan:null,plans:[],libraryEntitlement:[],librarySelection:[],provisioningState:null,hasJellyfin:false,hasStremio:false});
    assert.match(empty,/Choose how you want to watch/);assert.match(empty,/No plans are currently available/i);assert.match(empty,/Choose your access/);assert.doesNotMatch(empty,/Your referral code/,'Disabled Benefits module must not appear in the portal');

    const onboarding=await ejs.renderFile(path.join(__dirname,'..','views','customer','onboarding.ejs'),{
        siteName:'Test Streams',portal:{customer:{login_username:'newviewer'}},currency:'USD',csrfToken:'csrf-test',message:null,error:null,openCheckout:null,stripeEnabled:true,paypalEnabled:true,plisioEnabled:true,
        plans:[
            {id:'free-1',code:'free-server',name:'Free Server',audience:'direct',service_type:'jellyfin',is_free_tier:true,billing_interval:'custom',price_minor:0,currency:'USD',streams:1,capacity:{soldOut:false,remaining:5,limit:10},payment_options:[]},
            {id:'paid-1',code:'monthly',name:'Monthly',audience:'direct',service_type:'jellyfin',billing_interval:'month',price_minor:600,currency:'USD',streams:3,capacity:{soldOut:false,remaining:50,limit:60},payment_options:[{provider:'stripe',checkoutMode:'payment'},{provider:'stripe',checkoutMode:'subscription'},{provider:'paypal',checkoutMode:'payment'},{provider:'paypal',checkoutMode:'subscription'},{provider:'plisio',checkoutMode:'payment'}]},
            {id:'stremio-1',code:'stremio-month',name:'Stremio Monthly',audience:'direct',service_type:'stremio',billing_interval:'month',price_minor:500,currency:'USD',streams:1,capacity:{soldOut:false,remaining:20,limit:20},payment_options:[]}
        ]
    });
    assert.match(onboarding,/Free Server Plans/);assert.match(onboarding,/Paid Plans/);assert.match(onboarding,/Stremio Plans/);assert.match(onboarding,/Stripe · One-off payment/);assert.match(onboarding,/Stripe · Subscription/);assert.match(onboarding,/PayPal · One-off payment/);assert.match(onboarding,/PayPal · Subscription/);assert.match(onboarding,/Plisio · One-off payment/);assert.strictEqual((onboarding.match(/PayPal · Subscription/g)||[]).length,1,'PayPal subscription option should have a distinct single label');
    console.log('customer portal view smoke: ok');
})().catch(error=>{console.error(error);process.exit(1);});
