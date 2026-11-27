'use strict';

// No-database checks for "a repurchase never costs paid time": server decisions,
// the browser plan cards, past-access Re-subscribe, queue movement call sites
// and a schema guard over the SQL that only PostgreSQL can fully execute.

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const ejs=require('ejs');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');

// The database module is replaced before anything requires it.
let queryHandler=async sql=>{throw new Error('Unexpected query: '+sql);};
let transactionClient=null;
const dbPath=require.resolve('../src/db');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{
  query:(sql,params)=>queryHandler(sql,params),
  transaction:async work=>work(transactionClient),
  poolStats:()=>({max:1,total:0,idle:0,waiting:0,maxWaiting:1,saturated:false,overloaded:false}),
  getPool:()=>{throw new Error('No database in this smoke.');}
}};

const subscriptionState=require('../src/entitlements/subscription-state');
const providerPricing=require('../src/payments/provider-plan-pricing');
const samePlanRepurchase=require('../src/payments/same-plan-repurchase');
const extensions=require('../src/payments/subscription-access-extensions');
const prepaidRefunds=require('../src/payments/lifecycle-prepaid-refunds');
const checkout=require('../src/platform/flexible-checkout');
const compatibility=require('../src/db-compatibility-migrations');
const health=require('../src/platform/health');

const DAY=86400000;
const MIGRATION='20261127150000_paid_time_survives_repurchase.sql';
const plan={id:'plan-1',code:'monthly',name:'Monthly',service_type:'jellyfin',billing_interval:'month',duration_days:30,price_minor:600,currency:'GBP',streams:1};
const held=()=>({id:'plan-1',plan_id:'plan-1',subscription_id:'sub-1',customer_id:'cust-1',status:'active',source:'stripe',billing_mode:'payment',price_minor:600,billing_interval:'month',streams:1,service_extension_days:0,current_period_end:new Date(Date.now()+10*DAY),commercial_snapshot:{accessQuantity:1,accessVariantKind:'streams'}});
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

async function currentHolderRules(){
  const original=subscriptionState.effectiveSubscription;
  try{
    let row=held();
    subscriptionState.effectiveSubscription=async()=>row;
    assert(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),'a one-off holder of this plan must be recognised');
    row={...held(),plan_id:'other'};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'a different plan is not a same-plan holder');
    row={...held(),current_period_end:new Date(Date.now()-DAY)};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'ended access cannot be extended');
    row={...held(),status:'expired',current_period_end:new Date(Date.now()-DAY),service_extension_days:5};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'mirrors the checkout rule for expired rows');
    row={...held(),is_free_tier:true};
    assert.equal(await samePlanRepurchase.currentPaidSubscription('cust-1',plan),null,'free access is never extended');

    row=held();
    let facts={has_queued:false,change_open:false};
    queryHandler=async()=>({rows:[facts],rowCount:1});
    assert.deepStrictEqual(await samePlanRepurchase.extensionTarget('cust-1',plan),{subscriptionId:'sub-1'});
    facts={has_queued:true,change_open:false};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension while purchases are queued');
    facts={has_queued:false,change_open:true};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension during a plan change');
    facts={has_queued:false,change_open:false};
    row={...held(),service_extension_days:3640};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension past the cap');
    row={...held(),blocked:true};
    assert.equal(await samePlanRepurchase.extensionTarget('cust-1',plan),null,'no extension on a held account');

    const rows=[{id:'migrated',renewing:false,queue_protected:true},{id:'renewing',renewing:true,queue_protected:true},{id:'granted',renewing:false,queue_protected:false}];
    const db=async sql=>{assert(sql.includes('public.prepaid_paid_time'),'the shared paid-time definition decides whether queueing protects');return{rows};};
    assert.deepStrictEqual(await samePlanRepurchase.assessHolding('cust-1','plan-1',{db}),{current:true,unprotectedIds:['renewing','granted']},'a renewing agreement is never protected by queueing');
    await assert.rejects(samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db}),{code:'SAME_PLAN_PURCHASE_UNPROTECTED'});
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'subscription_extension'},{db});
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db:async()=>({rows:[rows[0]]})});
    await samePlanRepurchase.assertPurchaseKeepsPaidTime({customerId:'cust-1',planId:'plan-1',kind:'direct_plan'},{db:async()=>({rows:[]})});
  }finally{subscriptionState.effectiveSubscription=original;}
}

async function repurchaseDecision(){
  const originalHolding=samePlanRepurchase.assessHolding,originalTarget=samePlanRepurchase.extensionTarget,originalOptions=providerPricing.getExtensionOptions,originalWarn=console.warn;
  const payment={...plan,checkout_mode:'payment',variant_kind:'streams',access_quantity:1,quantity:1};
  const recurring={...payment,checkout_mode:'subscription'};
  try{
    console.warn=()=>{};
    const unprotected={current:true,unprotectedIds:['sub-1']},queued={current:true,unprotectedIds:[]},none={current:false,unprotectedIds:[]};
    let holding=unprotected,target={subscriptionId:'sub-1'},subscription=held(),fullPlanLookups=0;
    samePlanRepurchase.assessHolding=async()=>holding;
    samePlanRepurchase.extensionTarget=async()=>target;
    providerPricing.getExtensionOptions=async()=>{fullPlanLookups++;return[payment];};
    queryHandler=async sql=>{
      if(sql.includes('FROM plans WHERE code'))return{rows:[plan],rowCount:1};
      if(sql.includes('public.subscription_access_blocked'))return{rows:[subscription],rowCount:1};
      throw new Error('Unexpected query: '+sql);
    };
    const request=(body={})=>({session:{customerId:'cust-1'},body});
    const decide=(options,requested='payment',body={})=>checkout.repurchaseAsExtension(request(body),'stripe','monthly',1,requested,options);
    const refused=(promise,message)=>assert.rejects(promise,{code:'SAME_PLAN_PURCHASE_UNPROTECTED'},message);

    assert.equal((await decide([payment])).subscriptionId,'sub-1','time that queueing cannot protect is extended');
    assert.equal((await decide([payment],null)).subscriptionId,'sub-1','a single one-off option counts as a one-off purchase');
    assert.equal(await decide([payment,recurring],null),null,'an unresolved payment-type choice is left to the choice page');
    assert.equal(await decide([recurring],'subscription'),null,'recurring checkouts are untouched');
    await refused(decide([payment],'payment',{discountCode:'SAVE'}),'a promo code cannot buy a purchase that runs over paid time, including a zero-value one');
    await refused(decide([payment],'payment',{applyServiceCredit:'on'}),'service credit cannot either');
    await refused(decide([recurring],'payment'),'no one-off price is invented for a plan that only sells renewals');
    target=null;await refused(decide([payment]),'queued rows, a plan change or a held account refuse instead of overlapping');
    target={subscriptionId:'another'};await refused(decide([payment]),'an extension of a different row does not protect the unprotected one');
    target={subscriptionId:'sub-1'};subscription={...held(),commercial_snapshot:{accessQuantity:3}};
    await refused(decide([payment]),'a different allowance is refused, not sold over paid time');
    subscription={...held(),blocked:true};await refused(decide([payment]));
    subscription=held();
    samePlanRepurchase.extensionTarget=async()=>{throw new Error('boom');};
    await refused(decide([payment]),'an unexpected conversion failure never falls through to a direct purchase');
    samePlanRepurchase.extensionTarget=async()=>target;
    samePlanRepurchase.assessHolding=async()=>{throw new Error('function does not exist');};
    await assert.rejects(decide([payment]),{code:'SAME_PLAN_PURCHASE_UNVERIFIED'},'an unverifiable holder is refused before money');
    samePlanRepurchase.assessHolding=async()=>holding;

    // Protected holders and buyers without current time are never refused.
    for(const state of [queued,none]){
      holding=state;
      for(const body of [{},{discountCode:'SAVE'},{applyServiceCredit:'on'}])assert.equal(await decide([payment],'payment',body),null);
    }
    holding=queued;target=null;
    assert.equal(fullPlanLookups,0);
    assert.equal(await decide([]),null,'a full plan with no possible extension keeps the existing direct answer');
    assert.equal(await decide([],'payment',{discountCode:'SAVE'}),null);
    target={subscriptionId:'sub-1'};
    assert.equal((await decide([])).subscriptionId,'sub-1','the holder of a full plan can still add time');
    assert.equal(fullPlanLookups,1);
    for(const message of Object.values(samePlanRepurchase.MESSAGES))assert(checkout.CHECKOUT_SAFE.includes(message),'refusals must reach the customer');
    const intents=read('src/payments/checkout-intents.js');
    assert(intents.indexOf('assertPurchaseKeepsPaidTime')>intents.indexOf('await lockCheckoutOwner(client, customerId);')&&intents.indexOf('assertPurchaseKeepsPaidTime')<intents.indexOf('INSERT INTO billing_checkout_intents'),'every intent is checked under the customer lock');
    const zero=read('src/payments/zero-value-checkout.js');
    assert(zero.indexOf('assertPurchaseKeepsPaidTime')>0&&zero.indexOf('assertPurchaseKeepsPaidTime')<zero.indexOf('INSERT INTO subscriptions('),'zero-value settlement applies the same rule');
    const primitives=read('src/payments/lifecycle-primitives.js');
    assert(!primitives.includes('assertPurchaseKeepsPaidTime'),'nothing new may refuse a paid activation');
  }finally{samePlanRepurchase.assessHolding=originalHolding;samePlanRepurchase.extensionTarget=originalTarget;providerPricing.getExtensionOptions=originalOptions;console.warn=originalWarn;}
}

async function queueMovementCallSites(){
  const replayCalls=[];
  const prior={customer_id:'cust-1',subscription_id:'sub-1',plan_id:'plan-1',provider:'stripe',provider_payment_id:'pi_1'};
  const replay=await extensions.applyPurchase({query:async sql=>{
    replayCalls.push(sql);
    if(sql.includes('FROM subscription_access_extensions'))return{rows:[prior],rowCount:1};
    return{rows:[{id:'sub-1',service_extension_days:30}],rowCount:1};
  }},{customerId:'cust-1',subscriptionId:'sub-1',planId:'plan-1',provider:'stripe',providerPaymentId:'pi_1'});
  assert.equal(replay.replay,true);
  assert(!replayCalls.some(sql=>sql.includes('shift_prepaid_queue')),'a provider replay must not move queued time again');

  const calls=[];
  const end=new Date(Date.now()+10*DAY);
  const extension={id:'ext-1',customer_id:'cust-1',subscription_id:'sub-1',status:'active',purchased_days:30,applied_days:30,commercial_snapshot:{billingInterval:'month',durationDays:30}};
  transactionClient={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('SELECT s.id,s.service_extension_days'))return{rows:[{id:'sub-1',service_extension_days:30}],rowCount:1};
    if(sql.includes("SET status='revoked'"))return{rows:[{...extension,status:'revoked'}],rowCount:1};
    if(sql.includes('SELECT * FROM subscriptions'))return{rows:[{id:'sub-1',service_extension_days:30,current_period_end:end}],rowCount:1};
    if(sql.includes('WHERE subscription_id=$1'))return{rows:[{...extension,status:'revoked'}],rowCount:1};
    if(sql.includes('WHERE provider=$1 AND provider_payment_id=$2'))return{rows:[extension],rowCount:1};
    return{rows:[{id:'sub-1',service_extension_days:0}],rowCount:1};
  }};
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:'pi_1',customerId:'cust-1'});
  const position=text=>calls.findIndex(call=>call.sql.includes(text));
  assert(position('FOR UPDATE OF c')===0&&position('FOR UPDATE OF c')<position('FOR UPDATE OF s'),'customer row is locked first, as activation does');
  assert(!calls[0].sql.includes('starts_at'),'the customer lock does not depend on a racy look at the queue');
  const shift=calls[position('shift_prepaid_queue_after_extension_change')];
  assert(shift,'revoking bought time must move the queue back');
  assert.deepStrictEqual(shift.params,['sub-1',30],'the move is measured from the days held before the revoke');
  assert(calls.indexOf(shift)>position('UPDATE subscriptions SET service_extension_days'),'the queue moves after the new access end is written');

  const source=read('src/payments/subscription-access-extensions.js');
  const applied=source.slice(source.indexOf('async function applyPurchase'),source.indexOf('async function extensionIdentity'));
  assert(applied.indexOf('shiftQueuedPurchases(client')>applied.indexOf('service_extension_days=COALESCE(service_extension_days,0)+$2'),'buying time must move the queue in the same transaction');

  const refundCalls=[];
  const originalEnd=new Date(Date.now()+20*DAY),cutoff=new Date(Date.now());
  transactionClient={query:async(sql,params)=>{
    refundCalls.push({sql,params});
    if(sql.includes('FOR UPDATE OF s'))return{rows:[{id:'sub-1',customer_id:'cust-1',status:'active',starts_at:new Date(Date.now()-10*DAY),current_period_end:originalEnd,service_extension_days:7,service_type:'jellyfin'}],rowCount:1};
    return{rows:[],rowCount:0};
  }};
  const result=await prepaidRefunds.applyPrepaidRefund({subscriptionId:'sub-1',customerId:'cust-1',originalEnd,cutoffAt:cutoff,serviceType:'jellyfin'});
  const pull=refundCalls.find(call=>call.sql.includes('public.pull_prepaid_queue'));
  assert(pull,'a pro-rata refund moves queued purchases through the shared owner');
  assert(/FROM customers WHERE id=\$1 FOR UPDATE/.test(refundCalls[0].sql),'a pro-rata refund locks the customer before the subscription');
  assert.deepStrictEqual(refundCalls[0].params,['cust-1']);
  const migrationSql=read(`db/migrations/${MIGRATION}`),reconciler=migrationSql.slice(migrationSql.indexOf('FUNCTION reconcile_future_prepaid_full_refund'));
  assert(reconciler.indexOf('PERFORM 1 FROM customers')>0&&reconciler.indexOf('PERFORM 1 FROM customers')<reconciler.indexOf('SELECT s.* INTO refunded'),'the refund trigger uses the same order');
  assert.equal(pull.params[3],result.removedMs);
  assert.equal(pull.params[4],7,'extension days removed with the row are part of the vacated slot');
  assert.equal(pull.params[5],'sub-1','the refunded row never blocks its own queue');
}

// A very small DOM: enough to run the two browser scripts.
function node(extra={}){
  return Object.assign({dataset:{},children:[],textContent:'',innerHTML:'',classList:{add(){},remove(){},toggle(){}},
    append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},prepend(){},
    setAttribute(){},addEventListener(){},insertAdjacentElement(){},querySelector:()=>null,querySelectorAll:()=>[],closest:()=>null,remove(){}},extra);
}
function parseForms(html){
  return Array.from(String(html).matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)).map(match=>{
    const inputs={};
    for(const input of match[2].matchAll(/<input\b[^>]*>/g)){
      const name=/name="([^"]+)"/.exec(input[0])?.[1],value=/value="([^"]*)"/.exec(input[0])?.[1]||'';
      if(name)inputs[name]=value;
    }
    return{action:match[1],inputs,button:/<button\b[^>]*class="([^"]+)"[^>]*>([\s\S]*?)<\/button>/.exec(match[2])?.slice(1,3)||[]};
  });
}

async function clientCards(){
  const variantPlan={planId:'plan-1',code:'monthly',kind:'streams',preferredQuantity:1,currentPlan:true,currentQuantity:1,currentProvider:null,
    extension:{subscriptionId:'sub-1',quantity:1,durationLabel:'Monthly',providers:['stripe','paypal','plisio']},
    variants:[1,2].map(quantity=>({quantity,priceMinor:600*quantity,currency:'GBP',priceLabel:'price',soldOut:quantity===1,paymentOptions:[{provider:'stripe',checkoutMode:'payment'}]}))};

  async function run(planState){
    let appended=[];
    const actions=node();
    const forms=()=>parseForms(actions.innerHTML).map(form=>({
      getAttribute:()=>form.action,
      querySelector:selector=>{
        if(selector==='input[name="extensionSubscriptionId"]')return'extensionSubscriptionId' in form.inputs?{}:null;
        return null;
      },
      appendChild:input=>appended.push({form,input})
    }));
    const card=node({dataset:{planCode:'monthly'},querySelector:selector=>selector==='.planActions'?actions:selector==='.planDescription'?node():null,
      querySelectorAll:selector=>selector==='form'?forms():[]});
    let select=null,change=null;
    const document={
      querySelector:selector=>selector==='input[name="_csrf"]'?{value:'csrf'}:selector.startsWith('[data-plan-code=')?card:null,
      querySelectorAll:selector=>selector==='[data-plan-code]'?[card]:[],
      addEventListener(){},
      createElement(tag){
        if(tag==='input')return node();
        const element=node();
        element.querySelector=selector=>{
          if(selector!=='select')return null;
          select=node({value:/<option value="(\d+)" selected/.exec(element.innerHTML)?.[1],addEventListener:(_type,handler)=>{change=handler;}});
          return select;
        };
        return element;
      }
    };
    const fetch=async url=>({ok:!String(url).includes('readiness'),json:async()=>String(url).includes('plan-variants')?{plans:[planState]}:{media:false}});
    vm.runInNewContext(read('public/js/customer-checkout.js'),{document,fetch,CSS:{escape:String},window:{},Intl,setTimeout,clearTimeout,console});
    await settle();
    assert(select,'the variant picker must be installed');
    return{actions,appended:()=>appended,reset:()=>{appended=[];},choose:value=>{select.value=String(value);change();}};
  }

  const page=await run(variantPlan);
  let forms=parseForms(page.actions.innerHTML);
  assert(page.actions.innerHTML.includes('Current access allowance'));
  assert.deepStrictEqual(forms.map(form=>form.action),['/account/checkout/stripe','/account/checkout/paypal','/account/checkout/plisio'],'a one-off holder keeps every Extend button, even when the held allowance is full');
  assert(forms.every(form=>form.inputs.extensionSubscriptionId==='sub-1'&&form.inputs.checkoutMode==='payment'&&form.inputs.accessQuantity==='1'));

  // Equivalent to the server-rendered forms: same fields, labels and data attributes.
  const view=read('views/customer/dashboard.ejs');
  const end=new Date(Date.now()+10*DAY);
  const current={...plan,id:'sub-1',plan_id:'plan-1',subscription_id:'sub-1',status:'active',source:'stripe',current_period_end:end,commercial_snapshot:{streams:1}};
  const html=ejs.render(view,{siteName:'Test',currency:'GBP',portal:{customer:{login_username:'viewer'},subscriptions:[current],accounts:[],providers:[]},currentPlan:current,freePlan:null,stremioPlan:null,embyPlan:null,
    plans:[{...plan,payment_options:[{provider:'stripe'},{provider:'paypal'},{provider:'plisio'}]}],stripeEnabled:true,paypalEnabled:true,plisioEnabled:true,csrfToken:'csrf',message:null,error:null,openCheckout:null,openPlanChange:null,renewalSubscription:null,
    overseerrUrl:null,requestAccess:null,requestSyncConfigured:false,provisioningState:null,hasJellyfin:true,hasStremio:false,hasEmby:false,jellyfinAccounts:[],embyAccounts:[]},{filename:path.join(root,'views','customer','dashboard.ejs')});
  const server=parseForms(html).filter(form=>'extensionSubscriptionId' in form.inputs);
  assert.deepStrictEqual(forms,server,'browser-built Extend forms must match the server-rendered ones');
  assert(page.actions.innerHTML.includes('name="discountCode" data-promo-target'),'promo behaviour is unchanged on Extend forms');

  page.reset();
  page.choose(2);
  forms=parseForms(page.actions.innerHTML);
  assert(forms.some(form=>!('extensionSubscriptionId' in form.inputs)&&form.inputs.accessQuantity==='2'),'another allowance can still be bought');
  assert.equal(forms.filter(form=>form.inputs.extensionSubscriptionId==='sub-1').length,3,'choosing another allowance must not wipe Extend forms');
  assert(page.appended().length>0,'purchase forms still receive the server location');
  assert(page.appended().every(entry=>!('extensionSubscriptionId' in entry.form.inputs)),'Extend forms never pick a server location');

  const recurring=await run({...variantPlan,currentProvider:'stripe'});
  assert.equal(parseForms(recurring.actions.innerHTML).filter(form=>form.inputs.extensionSubscriptionId).length,3,'recurring payers who can extend keep Extend');
}

async function pastAccessResubscribe(){
  async function run(sourceForms){
    let section=null;
    const clone=form=>node({action:form.action,extension:form.extension,querySelector:selector=>selector==='button'?node():null});
    const source=node({querySelectorAll:()=>sourceForms.map(form=>({
      querySelector:selector=>selector==='input[name="extensionSubscriptionId"]'&&form.extension?{}:null,
      cloneNode:()=>clone(form)
    }))});
    const anchor=node({insertAdjacentElement:(_where,element)=>{section=element;}});
    const document={head:node(),createElement:()=>node(),
      querySelector:selector=>selector==='.multiAccessSummary'?anchor:selector.startsWith('.planCard')?source:null,
      querySelectorAll:()=>[]};
    const fetch=async()=>({ok:true,json:async()=>({items:[{paid:true,planCode:'monthly'}]})});
    vm.runInNewContext(read('public/js/customer-home-access.js'),{document,fetch,location:{pathname:'/account'},window:{},Intl,Date,console});
    await settle();
    const found=[];
    (function walk(element){if(!element||typeof element!=='object')return;if(element.action||element.href)found.push(element);for(const child of element.children||[])walk(child);})(section);
    return found;
  }
  const extend={action:'/account/checkout/stripe',extension:true},buy={action:'/account/checkout/paypal',extension:false};
  assert.deepStrictEqual((await run([extend,buy])).map(item=>item.action),['/account/checkout/paypal'],'Re-subscribe never clones an Extend form');
  const onlyExtend=await run([extend]);
  assert.equal(onlyExtend.length,1);
  assert.equal(onlyExtend[0].href,'/account?skipRestore=1#plans','with only Extend forms the card links to the plan instead');
}

// PostgreSQL is not available to fast checks, so at least prove that every
// column named through a table alias exists in the migration history.
function schemaGuard(){
  const directory=path.join(root,'db','migrations'),columns=new Map();
  const add=(table,column)=>{if(!columns.has(table))columns.set(table,new Set());columns.get(table).add(column.toLowerCase());};
  for(const file of fs.readdirSync(directory).filter(name=>name.endsWith('.sql'))){
    const sql=read('db/migrations/'+file).replace(/--.*$/gm,'');
    for(const match of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)){
      for(const line of match[2].split('\n')){const name=/^\s*([a-z_][a-z0-9_]*)\s+\S/.exec(line)?.[1];if(name)add(match[1],name);}
    }
    for(const statement of sql.split(';')){
      const table=/ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?(\w+)/i.exec(statement)?.[1];
      if(!table)continue;
      for(const match of statement.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)/gi))add(table,match[1]);
    }
  }
  function check(file,aliases){
    const sql=read(file).replace(/--.*$/gm,'');
    let checked=0;
    for(const [alias,tables] of Object.entries(aliases)){
      for(const match of sql.matchAll(new RegExp(`(?<![\\w.])${alias}\\.([a-z_][a-z0-9_]*)`,'g'))){
        assert(tables.some(table=>columns.get(table)?.has(match[1])),`${file}: ${alias}.${match[1]} is not a column of ${tables.join('/')}`);
        checked++;
      }
    }
    assert(checked>10,`${file}: schema guard found too few references to be meaningful`);
  }
  assert(columns.get('subscriptions')?.has('billing_mode')&&columns.get('subscriptions')?.has('media_server_id'),'schema guard must understand later column additions');
  check(`db/migrations/${MIGRATION}`,{s:['subscriptions'],p:['plans'],held:['subscriptions'],held_plan:['plans'],bought:['plans'],anchor:['subscriptions'],refunded:['subscriptions'],host_server:['jellyfin_servers'],NEW:['subscriptions','payment_incidents']});
  check('docs/paid-time-overlap-report.sql',{s:['subscriptions'],p:['plans'],pi:['payment_incidents'],al:['audit_log'],c:['customers']});
}

function contracts(){
  const migration=read(`db/migrations/${MIGRATION}`),report=read('docs/paid-time-overlap-report.sql');
  assert(compatibility.isRepeatableCompatibilityMigration(MIGRATION),'the migration must stay rolling-compatible');
  assert(/^BEGIN;$/m.test(migration)&&/^COMMIT;$/m.test(migration));
  const statementsOnly=migration.replace(/--.*$/gm,'');
  assert(!/\b(ALTER|DROP|CREATE)\s+(TABLE|TRIGGER|INDEX)\b/i.test(statementsOnly),'no table or trigger DDL: it would lock live tables');
  assert(!/\bDROP FUNCTION\b/i.test(statementsOnly),'functions only, safe to re-run');
  const timeout=migration.indexOf("SET LOCAL lock_timeout = '5s';");
  assert(timeout>0&&timeout<migration.indexOf('CREATE OR REPLACE FUNCTION'),'a blocked migration must give up before touching anything');
  // The triggers that call the replaced functions come from the older, immutable
  // migrations that every fresh install applies first.
  for(const [file,trigger,call] of [
    ['20260829202000_prepaid_access_stacking.sql','trg_stack_prepaid_subscription_window','BEFORE INSERT ON subscriptions\nFOR EACH ROW\nEXECUTE FUNCTION stack_prepaid_subscription_window();'],
    ['20260829212000_prepaid_refund_reconciliation.sql','trg_reconcile_future_prepaid_full_refund','AFTER INSERT ON payment_incidents\nFOR EACH ROW\nEXECUTE FUNCTION reconcile_future_prepaid_full_refund();']
  ])assert(read('db/migrations/'+file).includes('CREATE TRIGGER '+trigger+'\n'+call),trigger+' must still be installed by '+file);
  assert(migration.includes('pg_advisory_xact_lock(hashtextextended(NEW.customer_id::text,0))'),'stacking keeps the same serialization lock');
  assert(!/RAISE\s+EXCEPTION/i.test(migration),'nothing here may start refusing a paid activation');
  assert(migration.includes("'fully_discounted_local'"));
  // Stacking, pulling and pushing share one anchor definition.
  assert.equal((migration.match(/FROM public\.prepaid_stack_anchors\(/g)||[]).length,3);
  // Every public function the migration creates is granted to the runtime roles
  // and listed as required; trigger functions need no EXECUTE grant.
  const names=signatures=>signatures.map(signature=>signature.slice('public.'.length,signature.indexOf('('))).sort();
  const created=Array.from(migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g),match=>match[1]).sort();
  assert.deepStrictEqual(names(Array.from(compatibility.REQUIRED_FUNCTIONS)),created);
  const grants=migration.slice(migration.indexOf('DO $grants$'),migration.indexOf('$grants$;'));
  assert.deepStrictEqual(Array.from(grants.matchAll(/'(public\.[^']+)'/g),match=>match[1]),Array.from(compatibility.REQUIRED_FUNCTIONS),'grant list and required list must match');
  for(const role of ['steamfusion_app','steamfusion_automation'])assert(grants.includes("'"+role+"'"));
  const statements=report.replace(/--.*$/gm,'');
  assert(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i.test(statements),'the report must stay read only');
  assert.equal((statements.match(/;/g)||[]).length,1,'the report is a single statement');
}

async function readinessNeedsTheFunctions(){
  let missing=[{name:'public.prepaid_paid_time(uuid)'}];
  queryHandler=async(sql,params)=>{
    if(sql.includes('has_function_privilege')){assert.deepStrictEqual(params[0],Array.from(compatibility.REQUIRED_FUNCTIONS));return{rows:missing,rowCount:missing.length};}
    if(sql.includes('FROM schema_migrations'))return{rows:[{filename:health.latestMigration()}],rowCount:1};
    return{rows:[],rowCount:0};
  };
  let result=await health.readinessChecks();
  assert.equal(result.checks.migrations,true,'repeatable migrations stay outside the versioned ledger');
  assert.equal(result.checks.billingFunctions,false);
  assert.equal(result.ok,false,'a build whose database functions are missing must not take traffic');
  missing=[];result=await health.readinessChecks();
  assert.equal(result.checks.billingFunctions,true);
  assert.equal(health.publicResult(result).checks.billingFunctions,true);
}

(async()=>{
  contracts();
  await readinessNeedsTheFunctions();
  schemaGuard();
  await currentHolderRules();
  await repurchaseDecision();
  await queueMovementCallSites();
  await clientCards();
  await pastAccessResubscribe();
  console.log('paid-time repurchase smoke: ok');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
