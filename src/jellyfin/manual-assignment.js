'use strict';

const {query}=require('../db');
const provisioning=require('./provisioning');
const placement=require('./placement');
const adminControl=require('./admin-control');

function accessKind(plan){if(plan?.billing_interval==='trial')return'trial';return Number(plan?.price_minor||0)===0?'free':'paid';}
function serviceType(plan){return String(plan?.service_type_snapshot||plan?.service_type||'jellyfin');}
async function activeAccounts(customerId){const r=await query(`SELECT ja.*,js.name AS server_name FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.disabled=FALSE AND ja.account_purpose='jellyfin' ORDER BY ja.is_primary DESC,ja.updated_at DESC`,[customerId]);return r.rows;}
// max_users is a public/automatic placement boundary, not an administrator
// ceiling. We still count every active managed Jellyfin identity so Customer 360
// can show the real 50/50, 51/50, 1000/50 state before a deliberate assignment.
async function assignedUsers(serverId){const r=await query(`SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE server_id=$1 AND disabled=FALSE`,[serverId]);return Number(r.rows[0]?.n||0);}

async function candidates(customerId){
  const entitlement=await provisioning.currentEntitlement(customerId);
  if(!entitlement)return{entitlement:null,servers:[],activeAccounts:await activeAccounts(customerId)};
  if(!['jellyfin','bundle'].includes(serviceType(entitlement)))return{entitlement,servers:[],activeAccounts:await activeAccounts(customerId)};
  const existing=await activeAccounts(customerId);

  // This is an operator picker, not automatic placement. Show every configured,
  // enabled Jellyfin server regardless of plan mapping, pool/class, capacity,
  // allow_new_users, paid/trial admission or placement mode. The remote server
  // still has to be technically usable when the administrator submits.
  const raw=await query(`
    SELECT js.*
    FROM jellyfin_servers js
    WHERE js.enabled=TRUE
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    ORDER BY CASE js.health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,
             js.priority,js.name
  `);
  const servers=[];
  const kind=accessKind(entitlement);
  for(const server of raw.rows){
    const users=await assignedUsers(server.id),max=Number(server.max_users||0),full=max>0&&users>=max;
    const warnings=[];
    if(server.server_class!==entitlement.server_class)warnings.push('different plan pool');
    if(!server.allow_new_users)warnings.push('closed to automatic new users');
    if(kind==='trial'&&!server.trial_enabled)warnings.push('trial admission disabled');
    if(kind==='paid'&&!server.paid_enabled)warnings.push('paid admission disabled');
    if(server.health_status&&server.health_status!=='healthy')warnings.push(String(server.health_status));
    if(full)warnings.push('configured capacity reached');
    servers.push({...server,assigned_users:users,remaining:max>0?Math.max(0,max-users):null,full,over_capacity_by:max>0?Math.max(0,users-max):0,admin_warnings:warnings});
  }
  servers.sort((a,b)=>placement.healthRank(a.health_status)-placement.healthRank(b.health_status)||Number(a.priority||100)-Number(b.priority||100)||String(a.name).localeCompare(String(b.name)));
  return{entitlement,servers,activeAccounts:existing};
}

async function assign(customerId,targetServerId,{actorUserId=null}={}){
  const state=await candidates(customerId);
  if(!state.entitlement)throw new Error('Give the customer an active Jellyfin plan before assigning a server.');
  if(!['jellyfin','bundle'].includes(serviceType(state.entitlement)))throw new Error('This plan does not include Jellyfin access.');
  if(state.activeAccounts.length)throw new Error('This customer already has active Jellyfin access. Use Move server instead.');
  const server=state.servers.find(s=>String(s.id)===String(targetServerId));
  if(!server)throw new Error('Choose an enabled Jellyfin server.');

  // Deliberate administrator assignment ignores application-level admission
  // rules. max_users remains unchanged and continues to gate storefront/public
  // acquisition and automatic placement. A 50/50 server can therefore become
  // 51/50 without advertising a new public place.
  const capacityOverride=Boolean(server.full);
  const assignedUsersBefore=Number(server.assigned_users||0);
  const maxUsers=Number(server.max_users||0)||null;

  const effective=await provisioning.effectivePolicyForCustomer(customerId,state.entitlement);
  const libraries=await provisioning.resolveLibraryAccessForServer(server.id,effective.unrestricted,effective.visibleNames,false);
  if(libraries.missing.length)throw new Error(`${server.name} is missing required libraries: ${libraries.missing.join(', ')}.`);

  const previous=await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 AND account_purpose='jellyfin' ORDER BY updated_at DESC LIMIT 1`,[customerId,server.id]);
  let account,reused=false;
  if(previous.rowCount){
    account=previous.rows[0];
    await provisioning.applyPolicy(account,effective,false);
    await provisioning.markPrimaryAccount(customerId,account.id);
    await query(`UPDATE jellyfin_accounts SET disabled=FALSE,password_setup_required=TRUE,updated_at=NOW() WHERE id=$1`,[account.id]);
    account={...account,disabled:false,is_primary:true,password_setup_required:true};reused=true;
  }else{
    account=await provisioning.createJellyfinAccount(customerId,server,effective,{makePrimary:true});
    await query(`UPDATE jellyfin_accounts SET password_setup_required=TRUE,updated_at=NOW() WHERE id=$1`,[account.id]);
    account.password_setup_required=true;
  }

  // Persist the exact operator choice only after target access exists. Future
  // background reconciliation then keeps this server instead of re-running
  // automatic placement and undoing the administrator's decision.
  await adminControl.forceServer(customerId,state.entitlement.subscription_id,server.id,{actorUserId,reason:'Manual Jellyfin server assignment'});

  const assignedUsersAfter=await assignedUsers(server.id);
  const overCapacityAfter=maxUsers?Math.max(0,assignedUsersAfter-maxUsers):0;
  const resultMeta={manualAssignment:true,adminForcedServer:true,reusedExistingAccount:reused,serverName:server.name,capacityOverride,assignedUsersBefore,assignedUsersAfter,maxUsers,overCapacityAfter,overriddenRules:server.admin_warnings||[]};
  await query(`INSERT INTO customer_provisioning_state(customer_id,status,attempt_count,consecutive_failures,last_error,last_attempt_at,last_success_at,next_attempt_at,subscription_id,plan_id,jellyfin_account_id,server_id,last_result,updated_at) VALUES($1,'healthy',1,0,NULL,NOW(),NOW(),NULL,$2,$3,$4,$5,$6::jsonb,NOW()) ON CONFLICT(customer_id) DO UPDATE SET status='healthy',consecutive_failures=0,last_error=NULL,last_attempt_at=NOW(),last_success_at=NOW(),next_attempt_at=NULL,subscription_id=EXCLUDED.subscription_id,plan_id=EXCLUDED.plan_id,jellyfin_account_id=EXCLUDED.jellyfin_account_id,server_id=EXCLUDED.server_id,last_result=EXCLUDED.last_result,updated_at=NOW()`,[customerId,state.entitlement.subscription_id,state.entitlement.plan_id,account.id,server.id,JSON.stringify(resultMeta)]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,capacityOverride?'admin.customer.server_assign.capacity_override':'admin.customer.server_assign',customerId,JSON.stringify({serverId:server.id,serverName:server.name,accountId:account.id,reusedExistingAccount:reused,planId:state.entitlement.plan_id,capacityOverride,assignedUsersBefore,assignedUsersAfter,maxUsers,overCapacityAfter,overriddenRules:server.admin_warnings||[]})]);
  return{account,server,reused,capacityOverride,assignedUsersBefore,assignedUsersAfter,maxUsers,overCapacityAfter};
}

module.exports={accessKind,candidates,assign,assignedUsers};
