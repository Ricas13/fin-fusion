'use strict';

const { query } = require('../db');
const base = require('./provisioning');
const control = require('./reconciliation-control');
const reconciliationLock = require('./reconciliation-lock');
const accessHolds = require('../entitlements/access-holds');
const subscriptionState = require('../entitlements/subscription-state');
const subscriptionExpiry = require('../entitlements/subscription-expiry');
const libraryPolicy = require('./account-library-policy');
const jellyfinPolicy = require('./policy');
const discordRoles = require('../integrations/discord-roles');

function serviceType(entitlement){return String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin');}
function laneState(result){return result?{active:Boolean(result.active),blocked:Boolean(result.blocked),subscriptionId:result.entitlement?.subscription_id||null,planId:result.entitlement?.plan_id||null,planCode:result.entitlement?.contract_plan_code||result.entitlement?.code||null,accountId:result.account?.id||null,serverId:result.account?.server_id||null}:null;}
function stateDetail(primaryEntitlement,outcome){const account=outcome?.account||null,discordStatus=outcome?.discord?.skipped?`skipped:${outcome.discord.skipped}`:outcome?.discord?'synced':null;return{subscriptionId:primaryEntitlement?.subscription_id||outcome?.free?.entitlement?.subscription_id||outcome?.stremio?.subscriptionId||null,planId:primaryEntitlement?.plan_id||outcome?.free?.entitlement?.plan_id||null,accountId:account?.id||null,serverId:account?.server_id||outcome?.stremio?.serverId||null,serviceType:serviceType(primaryEntitlement),result:{active:Boolean(outcome?.active),planCode:primaryEntitlement?.contract_plan_code||primaryEntitlement?.code||null,jellyfinAccountId:account?.id||null,serverId:account?.server_id||outcome?.stremio?.serverId||null,primary:laneState(outcome?.primary),free:laneState(outcome?.free),stremioStatus:outcome?.stremio?.status||null,discordStatus,reconciledAt:new Date().toISOString()}};}
function assertDiscordSyncResult(result){const errors=Array.isArray(result?.errors)?result.errors.filter(Boolean):[];if(errors.length){const error=new Error(`Discord role synchronization failed: ${errors.join('; ').slice(0,800)}`);error.code='DISCORD_ROLE_SYNC_FAILED';error.discordErrors=errors;throw error;}return result||{skipped:'no_result'};}

async function normalAccounts(customerId){const rows=await query(`SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin' ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC`,[customerId]);return rows.rows;}
async function disableAccounts(accounts){for(const account of accounts){if(!account.disabled&&account.server_enabled)await base.disableJellyfinAccount(account);}}

async function entitlementForAccount(customerId,account){
    if(!account)return null;
    if(String(account.access_lane||'primary')==='free')return subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true});
    const current=await base.currentEntitlement(customerId);
    return current&&!current.is_free_tier?current:null;
}

async function libraryPolicyForAccount(customerId,accountOrId,entitlementOverride=null){
    let account=accountOrId;
    if(!account||typeof account!=='object'){
        const found=await query(`SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.id=$1 AND ja.customer_id=$2 LIMIT 1`,[accountOrId,customerId]);
        if(!found.rowCount)throw new Error('Jellyfin account not found');
        account=found.rows[0];
    }
    const entitlement=entitlementOverride||await entitlementForAccount(customerId,account);
    if(!entitlement)return{account,entitlement:null,effective:null};
    const effective=await libraryPolicy.effectiveForAccount(customerId,entitlement,account);
    return{account,entitlement,effective};
}

async function setLibrarySelectionForAccount(customerId,accountId,names){
    const profile=await libraryPolicyForAccount(customerId,accountId);
    if(!profile.entitlement||!profile.effective)throw new Error('This Jellyfin account does not have current library access.');
    if(!profile.entitlement.allow_customer_library_choice)throw new Error('Library selection is managed by this plan.');
    const entitled=new Map(profile.effective.entitlementRows.filter(row=>row.effective).map(row=>[jellyfinPolicy.nameKey(row.name),row.name]));
    const chosen=[];
    for(const raw of Array.isArray(names)?names:[]){const match=entitled.get(jellyfinPolicy.nameKey(raw));if(match&&!chosen.includes(match))chosen.push(match);}
    await libraryPolicy.setScopedSelection(customerId,accountId,chosen);
    return chosen;
}

async function adoptExistingFreeAccount(customerId,accounts,freeEntitlement,primaryEntitlement){
    if(!freeEntitlement?.is_free_tier||accounts.some(account=>account.access_lane==='free'))return accounts;
    const primaryStart=primaryEntitlement?.starts_at?new Date(primaryEntitlement.starts_at).getTime():null;
    const candidates=accounts.filter(account=>account.server_enabled&&account.access_lane==='primary'&&account.server_class===freeEntitlement.server_class);
    let candidate=candidates.find(account=>!primaryEntitlement||account.server_class!==primaryEntitlement.server_class);
    if(!candidate&&primaryStart)candidate=candidates.find(account=>new Date(account.created_at||0).getTime()<primaryStart);
    if(!candidate&&!primaryEntitlement)candidate=candidates[0]||accounts.find(account=>account.server_enabled);
    if(!candidate)return accounts;
    await query(`UPDATE jellyfin_accounts SET access_lane='free',is_primary=CASE WHEN $2::boolean THEN FALSE ELSE is_primary END,updated_at=NOW() WHERE id=$1`,[candidate.id,Boolean(primaryEntitlement)]);
    candidate.access_lane='free';
    if(primaryEntitlement)candidate.is_primary=false;
    return accounts;
}

async function createLaneAccount(customerId,entitlement,lane,accounts,{makePrimary=false}={}){const server=await base.selectServerForPlan(entitlement);if(!server)throw new Error(`No eligible Jellyfin server is currently available for plan ${entitlement.contract_plan_code||entitlement.code}`);const effective=await libraryPolicy.effectiveForAccount(customerId,entitlement,{id:null,server_id:server.id});const account=await base.createJellyfinAccount(customerId,server,effective,{makePrimary});await query(`UPDATE jellyfin_accounts SET access_lane=$2,updated_at=NOW() WHERE id=$1`,[account.id,lane]);account.access_lane=lane;account.server_name=server.name;account.public_url=server.public_url;base.notifyNewJellyfinAccess(customerId,account).catch(()=>{});return{account,effective};}

async function reconcileLane(customerId,entitlement,lane,accounts,{makePrimary=false}={}){const laneAccounts=accounts.filter(account=>account.access_lane===lane);if(!entitlement||entitlement.blocked){await disableAccounts(laneAccounts);return{active:false,blocked:Boolean(entitlement?.blocked),entitlement:entitlement||null,account:null};}let account=laneAccounts.find(a=>a.is_primary&&a.server_class===entitlement.server_class&&a.server_enabled)||laneAccounts.find(a=>!a.disabled&&a.server_class===entitlement.server_class&&a.server_enabled)||laneAccounts.find(a=>a.server_class===entitlement.server_class&&a.server_enabled),effective;if(!account){const created=await createLaneAccount(customerId,entitlement,lane,makePrimary);account=created.account;effective=created.effective;accounts.push(account);}else{effective=await libraryPolicy.effectiveForAccount(customerId,entitlement,account);await base.applyPolicy(account,effective,false);account.disabled=false;if(makePrimary&&!account.is_primary){await base.markPrimaryAccount(customerId,account.id);for(const existing of accounts)existing.is_primary=existing.id===account.id;account.is_primary=true;}}await disableAccounts(laneAccounts.filter(old=>old.id!==account.id));await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('entitlement.reconcile_lane','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({lane,subscriptionId:entitlement.subscription_id,planCode:entitlement.contract_plan_code||entitlement.code,serverId:account.server_id,jellyfinAccountId:account.id})]);return{active:true,blocked:false,entitlement,account,effective};}

async function recordRun(customerId,subscriptionId,fn){const started=await query(`INSERT INTO provisioning_runs(customer_id,subscription_id,action,status,detail) VALUES($1,$2,'reconcile','started',$3::jsonb) RETURNING id`,[customerId,subscriptionId||null,JSON.stringify({mode:'multi_access'})]),id=started.rows[0].id;try{const value=await fn();await query(`UPDATE provisioning_runs SET status='succeeded',completed_at=NOW() WHERE id=$1`,[id]);return value;}catch(error){await query(`UPDATE provisioning_runs SET status='failed',detail=COALESCE(detail,'{}'::jsonb)||$2::jsonb,completed_at=NOW() WHERE id=$1`,[id,JSON.stringify({error:error.message})]);throw error;}}

async function reconcileCustomerUnlocked(customerId){const[effectiveJellyfin,freeEntitlement,stremioEntitlement]=await Promise.all([base.currentEntitlement(customerId),subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true}),require('../stremio/entitlements').entitledSubscription(customerId)]),primaryEntitlement=effectiveJellyfin&&!effectiveJellyfin.is_free_tier?effectiveJellyfin:null,controlEntitlement=primaryEntitlement||freeEntitlement||stremioEntitlement||null,activePlanIds=[primaryEntitlement&&!primaryEntitlement.blocked?primaryEntitlement.plan_id:null,freeEntitlement&&!freeEntitlement.blocked?freeEntitlement.plan_id:null,stremioEntitlement?.plan_id||null].filter(Boolean);await control.markCustomerRunning(customerId,controlEntitlement);try{const outcome=await recordRun(customerId,controlEntitlement?.subscription_id||null,async()=>{let accounts=await normalAccounts(customerId);accounts=await adoptExistingFreeAccount(customerId,accounts,freeEntitlement,primaryEntitlement);const primary=await reconcileLane(customerId,primaryEntitlement,'primary',accounts,{makePrimary:Boolean(primaryEntitlement)}),free=await reconcileLane(customerId,freeEntitlement,'free',accounts,{makePrimary:!primaryEntitlement&&Boolean(freeEntitlement&&!freeEntitlement.blocked)});if(!primaryEntitlement&&!free.active)await disableAccounts(accounts);const stremio=require('../stremio/entitlements');let stremioOutcome=null;if(stremioEntitlement)stremioOutcome=await stremio.reconcileForCustomer(customerId,stremioEntitlement);else await stremio.suspend(customerId,'No current Stremio subscription.');const discord=assertDiscordSyncResult(await discordRoles.syncRoleForCustomer(customerId,activePlanIds));const account=primary.account||free.account||null;return{active:Boolean(primary.active||free.active||stremioOutcome?.status==='active'),account,primary,free,stremio:stremioOutcome,discord};});await control.markCustomerHealthy(customerId,stateDetail(controlEntitlement,outcome));return outcome;}catch(error){const classified=control.classifyError(error);await control.markCustomerProblem(customerId,classified.status,error,stateDetail(controlEntitlement,null));throw error;}}
async function reconcileCustomer(customerId){return reconciliationLock.withCustomerReconciliationLock(customerId,()=>reconcileCustomerUnlocked(customerId));}
async function reconcileAccount(accountId){const result=await query('SELECT customer_id FROM jellyfin_accounts WHERE id=$1',[accountId]);if(!result.rowCount)throw new Error('Jellyfin account not found');return reconcileCustomer(result.rows[0].customer_id);}
function adminHoldType(reason){if(reason==='disabled')return'admin_disabled';if(reason==='suspended')return'admin_suspended';return'admin_hold';}
async function holdAccess(customerId,reason='suspended',actorUserId=null){const type=adminHoldType(String(reason||'suspended'));await accessHolds.addHold({customerId,type,sourceKey:'admin',reason:String(reason||type).slice(0,500),actorUserId});return reconcileCustomer(customerId);}
async function releaseAccess(customerId,actorUserId=null){await accessHolds.releaseAllAdminHolds(customerId,actorUserId);return reconcileCustomer(customerId);}
async function setJellyfinPassword(customerId,accountId,newPassword){const account=await query(`SELECT account_purpose FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2`,[accountId,customerId]);if(account.rows[0]?.account_purpose==='stremio_internal')throw new Error('Internal Stremio Jellyfin credentials cannot be changed through customer password controls.');return base.setJellyfinPassword(customerId,accountId,newPassword);}
async function renameJellyfinAccount(customerId,accountId,newUsername,options={}){const account=await query(`SELECT account_purpose FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2`,[accountId,customerId]);if(account.rows[0]?.account_purpose==='stremio_internal')throw new Error('Internal Stremio Jellyfin credentials cannot be renamed through customer controls.');return base.renameJellyfinAccount(customerId,accountId,newUsername,options);}
async function maybeAutoDowngrade(customerId){const lifecycle=require('../payments/lifecycle');try{return await lifecycle.autoDowngradeEligibleCustomer(customerId)}catch(error){console.error(`Automatic free-tier downgrade failed for ${customerId}:`,error.message);return null}}
async function syncRecurringSubscription(subscriptionId){return require('../payments/billing-control').syncSubscription(subscriptionId);}
async function expireSubscriptionsAndReconcile(){return subscriptionExpiry.expireAndReconcile({reconcileCustomer,autoDowngrade:maybeAutoDowngrade,syncRecurringSubscription,onProviderSyncError:(row,error)=>console.error(`Recurring provider verification failed before expiry for ${row?.id||'unknown'}:`,error.message),onReconcileError:(customerId,error)=>console.error(`Entitlement reconcile failed for ${customerId}:`,error.message)});}
module.exports={...base,reconcileCustomer,reconcileAccount,holdAccess,releaseAccess,setJellyfinPassword,renameJellyfinAccount,expireSubscriptionsAndReconcile,normalAccounts,reconcileLane,adoptExistingFreeAccount,control,libraryPolicyForAccount,setLibrarySelectionForAccount,reconciliationLock,assertDiscordSyncResult};
