'use strict';

const {query,transaction}=require('../db');
const subscriptionState=require('../entitlements/subscription-state');
const planExpiry=require('../entitlements/plan-expiry');
const accessHolds=require('../entitlements/access-holds');
const serviceAdminControl=require('../entitlements/service-admin-control');
const provisioning=require('../jellyfin/resilient-provisioning');
const provisioningHelpers=require('../jellyfin/provisioning-helpers');

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}

async function audit(actorUserId,action,customerId,metadata={}){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,action,customerId,JSON.stringify(metadata)]);
}

async function lockedSubscriptionForCustomer(client,customerId,subscriptionId){
  const result=await client.query(`
    SELECT s.*,p.is_free_tier,p.duration_days,p.billing_interval,
      EXISTS(
        SELECT 1 FROM audit_log terminal_audit
        WHERE terminal_audit.entity_type='subscription'
          AND terminal_audit.entity_id=s.id::text
          AND terminal_audit.action='billing.subscription.terminate_for_refund'
      ) AS refund_terminated
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.id=$1
      AND s.customer_id=$2
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND s.superseded_by IS NULL
    LIMIT 1
    FOR UPDATE OF s
  `,[subscriptionId,customerId]);
  const sub=result.rows[0]||null;
  if(!sub||sub.refund_terminated)throw new Error('That subscription is not available for this customer.');
  return sub;
}

async function lockedTrialSubscriptionForCustomer(client,customerId,subscriptionId){
  const result=await client.query(`
    SELECT s.*,p.is_free_tier,p.duration_days,p.billing_interval,p.service_type,p.is_addon,
      EXISTS(
        SELECT 1 FROM audit_log terminal_audit
        WHERE terminal_audit.entity_type='subscription'
          AND terminal_audit.entity_id=s.id::text
          AND terminal_audit.action='billing.subscription.terminate_for_refund'
      ) AS refund_terminated
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.id=$1
      AND s.customer_id=$2
      AND s.superseded_by IS NULL
    LIMIT 1
    FOR UPDATE OF s
  `,[subscriptionId,customerId]);
  const sub=result.rows[0]||null;
  if(!sub||sub.refund_terminated)throw new Error('That trial subscription is not available for this customer.');
  if(String(sub.status||'').toLowerCase()!=='trialing')throw new Error('Only a currently trialing subscription can have its trial clock reset.');
  const interval=String(sub.billing_interval_snapshot||sub.billing_interval||'').toLowerCase();
  if(interval!=='trial')throw new Error('The selected subscription is not a trial.');
  if(subscriptionState.recurringProvider(sub))throw new Error('Provider-controlled trials must be changed at Stripe/PayPal so billing and access stay aligned.');
  return sub;
}

async function jellyfinAccounts(customerId){
  const result=await query(`
    SELECT ja.*,js.name AS server_name
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1
      AND COALESCE(ja.account_purpose,'jellyfin')='jellyfin'
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    ORDER BY ja.created_at,ja.id
  `,[customerId]);
  return result.rows;
}

async function extend({customerId,actorUserId,subscriptionId,operationId,units}){
  const result=await transaction(async client=>{
    const sub=await lockedSubscriptionForCustomer(client,customerId,subscriptionId);
    if(planExpiry.isFreeTier(sub))throw new Error('Free Access has no expiry to extend.');
    const subId=sub.id||sub.subscription_id;
    const durationDays=Math.max(1,Number(sub.duration_days_snapshot||sub.duration_days||30));
    const requestedDays=durationDays*units;
    if(!Number.isInteger(requestedDays)||requestedDays<1)throw new Error('Requested service extension is invalid.');
    let remaining=requestedDays,chunk=0;
    const chunks=[];
    while(remaining>0){
      const days=Math.min(365,remaining);
      chunks.push({days,chunk,reference:`admin-single:${operationId}:${chunk}`});
      remaining-=days;
      chunk+=1;
    }
    const refs=chunks.map(row=>row.reference);
    const existingResult=await client.query(
      `SELECT subscription_id,customer_id,days,reference_id,metadata FROM subscription_service_extension_events WHERE source='admin_single' AND reference_id=ANY($1::text[])`,
      [refs]
    );
    const existing=new Map(existingResult.rows.map(row=>[String(row.reference_id),row]));
    for(const row of chunks){
      const prior=existing.get(row.reference);
      if(!prior)continue;
      if(String(prior.subscription_id)!==String(subId)
        ||String(prior.customer_id)!==String(customerId)
        ||Number(prior.days)!==Number(row.days)
        ||Number(prior.metadata?.units)!==units){
        throw new Error('This extension operation was already used with different subscription terms. Open a fresh action form.');
      }
    }
    const missing=chunks.filter(row=>!existing.has(row.reference));
    const missingDays=missing.reduce((sum,row)=>sum+row.days,0);
    const currentDays=Math.max(0,Number(sub.service_extension_days||0));
    if(currentDays+missingDays>3650)throw new Error('Requested service extension exceeds the 3,650-day safety limit.');
    let added=0;
    for(const row of missing){
      const inserted=await client.query(
        `INSERT INTO subscription_service_extension_events(subscription_id,customer_id,source,days,reference_id,metadata)
         VALUES($1,$2,'admin_single',$3,$4,$5::jsonb)
         ON CONFLICT(source,reference_id) DO NOTHING RETURNING id`,
        [subId,customerId,row.days,row.reference,JSON.stringify({mode:'single_customer',actorUserId,subscriptionId:subId,units,chunk:row.chunk})]
      );
      if(!inserted.rowCount)continue;
      await client.query(
        `UPDATE subscriptions SET service_extension_days=service_extension_days+$2,updated_at=NOW() WHERE id=$1 AND customer_id=$3`,
        [subId,row.days,customerId]
      );
      added+=row.days;
    }
    return{subId,requestedDays,added};
  });
  const warnings=[];
  try{
    await audit(actorUserId,'admin.customer.extend_entitlement',customerId,{
      subscriptionId:result.subId,units,requestedDays:result.requestedDays,addedDays:result.added,operationId
    });
  }catch(error){warnings.push(`audit logging needs review: ${clean(error.message||error,140)}`);}
  try{await provisioning.reconcileCustomer(customerId);}
  catch(error){warnings.push(`access reconciliation needs retry: ${clean(error.message||error,180)}`);}
  const base=result.added
    ?`${result.added} day${result.added===1?'':'s'} added to the selected subscription.`
    :'This extension had already been applied. No additional days were added.';
  return `${base}${warnings.length?` Warning: ${warnings.join('; ')}`:''}`;
}

async function setExpiry({customerId,actorUserId,subscriptionId,expiryDate}){
  const subId=await transaction(async client=>{
    const sub=await lockedSubscriptionForCustomer(client,customerId,subscriptionId);
    if(planExpiry.isFreeTier(sub))throw new Error('Free Access does not use an expiry date.');
    if(subscriptionState.recurringProvider(sub))throw new Error('Expiry on an active Stripe/PayPal recurring agreement is provider-controlled. Use billing cancellation or plan change instead.');
    const id=sub.id||sub.subscription_id;
    const updated=await client.query(
      `UPDATE subscriptions SET current_period_end=$2::date,service_extension_days=0,updated_at=NOW() WHERE id=$1 AND customer_id=$3 RETURNING id`,
      [id,expiryDate,customerId]
    );
    if(!updated.rowCount)throw new Error('The selected subscription changed before the expiry could be saved.');
    return id;
  });
  const warnings=[];
  try{
    await audit(actorUserId,'admin.customer.set_expiry',customerId,{subscriptionId:subId,expiryDate,clearedServiceExtensions:true});
  }catch(error){warnings.push(`audit logging needs review: ${clean(error.message||error,140)}`);}
  try{await provisioning.reconcileCustomer(customerId);}
  catch(error){warnings.push(`access reconciliation needs retry: ${clean(error.message||error,180)}`);}
  return `Expiry set to ${expiryDate} for the selected subscription.${warnings.length?` Warning: ${warnings.join('; ')}`:''}`;
}


async function resetExpiryToPlan({customerId,actorUserId=null}){
  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
  if(!entitlement)throw new Error('This customer has no active plan to reset expiry against.');
  if(subscriptionState.recurringProvider(entitlement))throw new Error('This expiry is controlled by Stripe/PayPal. Use Billing instead.');
  const subscriptionId=entitlement.subscription_id||entitlement.id;
  const end=planExpiry.endForPlan(entitlement);
  await transaction(async client=>{
    const locked=await client.query(
      'SELECT id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',
      [subscriptionId,customerId]
    );
    if(!locked.rowCount)throw new Error('The active subscription changed before expiry could be reset.');
    const updated=await client.query(
      'UPDATE subscriptions SET current_period_end=$2,service_extension_days=0,updated_at=NOW() WHERE id=$1 AND customer_id=$3 RETURNING id',
      [subscriptionId,end,customerId]
    );
    if(!updated.rowCount)throw new Error('The active subscription changed before expiry could be reset.');
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.customer.expiry.reset_to_plan','customer',$2,$3::jsonb)`,
      [actorUserId,customerId,JSON.stringify({
        subscriptionId,
        planId:entitlement.plan_id,
        currentPeriodEnd:end.toISOString(),
        providerBillingChanged:false
      })]
    );
  });
  await provisioning.reconcileCustomer(customerId);
  return{subscriptionId,end};
}

async function resetTrial({customerId,actorUserId,subscriptionId}){
  const now=new Date();
  const result=await transaction(async client=>{
    const sub=await lockedTrialSubscriptionForCustomer(client,customerId,subscriptionId);
    const subId=sub.id||sub.subscription_id;
    const durationDays=Math.max(1,Math.min(3650,Number(sub.duration_days_snapshot||sub.duration_days||1)));
    const end=new Date(now.getTime()+durationDays*86400000);
    const previous={
      startsAt:sub.starts_at?new Date(sub.starts_at).toISOString():null,
      currentPeriodEnd:sub.current_period_end?new Date(sub.current_period_end).toISOString():null,
      serviceExtensionDays:Number(sub.service_extension_days||0)
    };
    const updated=await client.query(`
      UPDATE subscriptions
      SET starts_at=$2,
          current_period_end=$3,
          service_extension_days=0,
          cancel_at_period_end=FALSE,
          updated_at=NOW()
      WHERE id=$1 AND customer_id=$4 AND status='trialing'
      RETURNING id,starts_at,current_period_end,status
    `,[subId,now,end,customerId]);
    if(!updated.rowCount)throw new Error('The trial changed before its duration could be reset.');
    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.trial.reset_duration','subscription',$2,$3::jsonb)
    `,[actorUserId,subId,JSON.stringify({
      customerId,
      subscriptionId:subId,
      planId:sub.plan_id,
      serviceType:String(sub.service_type_snapshot||sub.service_type||'jellyfin'),
      durationDays,
      previous,
      startsAt:now.toISOString(),
      currentPeriodEnd:end.toISOString(),
      clearedServiceExtensions:true,
      providerBillingChanged:false
    })]);
    return{subId,durationDays,start:now,end};
  });
  const warnings=[];
  try{await provisioning.reconcileCustomer(customerId);}
  catch(error){warnings.push(`access reconciliation needs retry: ${clean(error.message||error,180)}`);}
  return{
    ...result,
    message:`Trial reset to a fresh ${result.durationDays} day${result.durationDays===1?'':'s'} from now (ends ${result.end.toISOString()}). Existing service-extension days were cleared.${warnings.length?` Warning: ${warnings.join('; ')}`:''}`
  };
}

async function suspend({customerId,actorUserId,reason}){
  await accessHolds.addHold({
    customerId,type:'admin_suspended',sourceKey:'admin',reason,actorUserId,metadata:{origin:'customer_360'}
  });
  let reconcileError='',auditError='',outcome=null;
  try{outcome=await provisioning.reconcileCustomer(customerId);}
  catch(error){reconcileError=clean(error.message||error,400);}
  try{
    await audit(actorUserId,'admin.customer.suspend',customerId,{reason,active:Boolean(outcome?.active),reconcileError:reconcileError||null});
  }catch(error){auditError=clean(error.message||error,200);}
  const warnings=[
    reconcileError?`reconciliation needs attention: ${reconcileError}`:'',
    auditError?`audit logging needs review: ${auditError}`:''
  ].filter(Boolean);
  return warnings.length
    ?`Customer suspended. The hold is active. Warning: ${warnings.join('; ')}`
    :'Customer suspended. Access will remain held until the suspension is released.';
}

async function deleteJellyfin({customerId,actorUserId,reason}){
  const accounts=await jellyfinAccounts(customerId);
  if(!accounts.length)return 'No ordinary Jellyfin customer accounts were present. Nothing was deleted.';
  await audit(actorUserId,'admin.customer.jellyfin.delete_accounts.requested',customerId,{
    reason,
    accounts:accounts.map(row=>({accountId:row.id,serverId:row.server_id,username:row.jellyfin_username||null,accessLane:row.access_lane||null}))
  });
  await serviceAdminControl.setRemoved(customerId,'jellyfin',{actorUserId,reason});
  let reconcileError='';
  try{await provisioning.reconcileCustomer(customerId);}
  catch(error){reconcileError=clean(error.message||error,500);}
  let remaining=await jellyfinAccounts(customerId);
  const cleanupFailures=[];
  for(const account of remaining){
    try{await provisioningHelpers.deleteJellyfinAccount(account,{reason,actorUserId});}
    catch(error){cleanupFailures.push({accountId:account.id,username:account.jellyfin_username||null,error:clean(error.message||error,500)});}
  }
  remaining=await jellyfinAccounts(customerId);
  const removed=Math.max(0,accounts.length-remaining.length);
  let auditError='';
  try{
    await audit(actorUserId,'admin.customer.jellyfin.delete_accounts.completed',customerId,{
      reason,requested:accounts.length,removed,
      remaining:remaining.map(row=>({accountId:row.id,serverId:row.server_id,username:row.jellyfin_username||null,accessLane:row.access_lane||null})),
      cleanupFailures,reconcileError:reconcileError||null
    });
  }catch(error){auditError=clean(error.message||error,200);}
  if(remaining.length){
    throw new Error(`Jellyfin is now pinned to Removed, but ${remaining.length} account${remaining.length===1?' still exists':'s still exist'}. ${cleanupFailures[0]?.error||reconcileError||'Run the deletion action again after checking Jellyfin connectivity.'}`);
  }
  const warnings=[
    reconcileError?`another reconciliation step reported: ${reconcileError}`:'',
    auditError?`completion audit logging needs review: ${auditError}`:''
  ].filter(Boolean);
  return `${removed} Jellyfin account${removed===1?'':'s'} removed. Portal, billing history, Emby and Stremio identities were preserved.${warnings.length?` Warning: ${warnings.join('; ')}`:''}`;
}

module.exports={
  lockedSubscriptionForCustomer,
  lockedTrialSubscriptionForCustomer,
  jellyfinAccounts,
  extend,
  setExpiry,
  resetExpiryToPlan,
  resetTrial,
  suspend,
  deleteJellyfin
};
