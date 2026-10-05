'use strict';

const {query,transaction}=require('../db');
const subscriptionState=require('../entitlements/subscription-state');
const serviceScope=require('../entitlements/service-scope');
const planExpiry=require('../entitlements/plan-expiry');
const planChange=require('../payments/customer-plan-change');
const planPricing=require('../payments/plan-pricing');
const planCapacity=require('../entitlements/plan-capacity');
const provisioning=require('../jellyfin/resilient-provisioning');
const forceMove=require('../jellyfin/admin-force-move');
const serverMigration=require('../jellyfin/server-migration');
const customerServerChoice=require('../jellyfin/customer-server-choice');
const jellyfinAdminControl=require('../jellyfin/admin-control');

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function jellyfinCapable(row){return serviceScope.capabilities(row).has('jellyfin');}

async function subscriptionForCustomer(customerId,value){
  const id=String(value||'').trim();
  const result=await query(`
    SELECT s.*,p.is_free_tier,p.duration_days,p.billing_interval
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.id=$1
      AND s.customer_id=$2
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND s.superseded_by IS NULL
      AND NOT EXISTS(
        SELECT 1 FROM audit_log terminal_audit
        WHERE terminal_audit.entity_type='subscription'
          AND terminal_audit.entity_id=s.id::text
          AND terminal_audit.action='billing.subscription.terminate_for_refund'
      )
    LIMIT 1
  `,[id,customerId]);
  const sub=result.rows[0]||null;
  if(!sub)throw new Error('That subscription is not available for this customer.');
  return sub;
}

async function targetPlan(planId){
  const result=await query(`
    SELECT * FROM plans
    WHERE id=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL
      AND COALESCE(is_addon,FALSE)=FALSE AND audience='direct'
      AND (effective_from IS NULL OR effective_from<=NOW())
      AND (effective_until IS NULL OR effective_until>NOW())
  `,[planId]);
  if(!result.rowCount)throw new Error('Target primary plan not found or is not currently available.');
  return subscriptionState.assertAudience(result.rows[0],'customer');
}

async function audit(actorUserId,action,customerId,metadata={}){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,'customer',$3,$4::jsonb)`,
  [actorUserId,action,customerId,JSON.stringify(metadata)]);
}

async function lockSubscriptionForPlanChange(client,sub,target){
  const subscriptionId=sub.id||sub.subscription_id;
  const current=(await client.query(
    `SELECT plan_id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE`,
    [subscriptionId,sub.customer_id]
  )).rows[0]||null;
  if(!current)throw new Error('Subscription changed before the plan update could be applied.');
  if(String(current.plan_id)===String(target.id))return{subscriptionId,alreadyApplied:true};
  if(String(current.plan_id)!==String(sub.plan_id))throw new Error('This subscription changed after the action was opened. Refresh the customer and try again.');
  return{subscriptionId,alreadyApplied:false};
}

async function applyLocalPlanContract(sub,target){
  const preferredCurrency=String(sub.currency_snapshot||sub.currency||target.currency||'GBP').trim().toUpperCase();
  const price=await planPricing.resolvePrice(target.id,preferredCurrency,{allowFallback:true});
  if(!price)throw new Error('Target plan has no active price to snapshot.');
  const pricedTarget={...target,price_minor:Number(price.price_minor),currency:String(price.currency).toUpperCase(),plan_price_id:price.id};
  const mapping={price_minor:Number(price.price_minor),currency:String(price.currency).toUpperCase(),plan_price_id:price.id,external_id:null,provider_mapping_id:null};
  const snapshot=planChange.contractSnapshot(pricedTarget,mapping,sub.source||'admin');
  const periodEnd=planExpiry.endForPlan(target),freeTier=planExpiry.isFreeTier(target);
  let alreadyApplied=false;
  let targetMediaServer=null;
  await transaction(async client=>{
    const locked=await lockSubscriptionForPlanChange(client,sub,target);
    alreadyApplied=locked.alreadyApplied;
    if(alreadyApplied)return;

    await planCapacity.lockAndAssert(client,target.id,target.name||'This plan');

    if(customerServerChoice.mediaServerType(target)){
      const admin=await jellyfinAdminControl.state(sub.customer_id,locked.subscriptionId,{client});
      if(admin?.mode==='admin_server_pin'&&admin.server_id){
        const pinned=(await client.query(`
          SELECT * FROM jellyfin_servers
          WHERE id=$1 AND enabled=TRUE
            AND COALESCE(media_server_type,'jellyfin')='jellyfin'
          LIMIT 1
        `,[admin.server_id])).rows[0]||null;
        if(!pinned)throw new Error('The administrator-pinned Jellyfin server is unavailable. Repair the server pin before changing this plan.');
        targetMediaServer={...pinned,selected_location:customerServerChoice.locationLabel(pinned.location)};
      }else{
        targetMediaServer=await customerServerChoice.existingAssignedServerForPlan(
          target,
          sub.media_server_id,
          null,
          {db:(sql,params)=>client.query(sql,params)}
        );
        if(!targetMediaServer){
          targetMediaServer=await customerServerChoice.selectServerForLocationLocked(
            target,
            null,
            {db:(sql,params)=>client.query(sql,params),requireSelection:false}
          );
        }
      }
    }

    const mediaLocation=targetMediaServer?.selected_location||customerServerChoice.locationLabel(targetMediaServer?.location)||null;
    const commercialSnapshot={...snapshot,...(targetMediaServer?{mediaLocation,mediaServerId:targetMediaServer.id}:{})};
    const updated=await client.query(`UPDATE subscriptions
      SET plan_id=$2,plan_name_snapshot=$3,plan_code_snapshot=$4,price_minor_snapshot=$5,
          currency_snapshot=$6,billing_interval_snapshot=$7,duration_days_snapshot=$8,
          service_type_snapshot=$9,provider_price_id_snapshot=NULL,commercial_snapshot=$10::jsonb,
          plan_price_id_snapshot=$11,provider_mapping_id_snapshot=NULL,
          provider_mapping_external_id_snapshot=NULL,current_period_end=$12,
          service_extension_days=CASE WHEN $13::boolean THEN 0 ELSE service_extension_days END,
          media_location_preference=CASE WHEN $15::uuid IS NULL THEN media_location_preference ELSE $16 END,
          media_server_id=CASE WHEN $15::uuid IS NULL THEN media_server_id ELSE $15 END,
          media_location_snapshot=CASE WHEN $15::uuid IS NULL THEN media_location_snapshot ELSE $16 END,
          updated_at=NOW()
      WHERE id=$1 AND customer_id=$14 RETURNING id`,
      [locked.subscriptionId,target.id,target.name,target.code,Number(price.price_minor),
       String(price.currency).toUpperCase(),target.billing_interval,Number(target.duration_days||30),
       target.service_type,JSON.stringify(commercialSnapshot),price.id,periodEnd,freeTier,sub.customer_id,
       targetMediaServer?.id||null,mediaLocation]);
    if(!updated.rowCount)throw new Error('Subscription changed before the plan update could be applied.');
  });
  return{price,snapshot,periodEnd,freeTier,alreadyApplied,targetMediaServer};
}

async function changePlan({customerId,subscriptionId,targetPlanId,actorUserId=null}){
  const sub=await subscriptionForCustomer(customerId,subscriptionId);
  const target=await targetPlan(targetPlanId);
  if(!serviceScope.overlaps(sub,target)||!jellyfinCapable(target)){
    throw new Error(`The selected ${serviceScope.label(target)} plan is not a compatible Jellyfin target for this ${serviceScope.label(sub)} subscription.`);
  }
  if(subscriptionState.recurringProvider(sub)&&planExpiry.isFreeTier(target)){
    throw new Error('Recurring Stripe/PayPal subscriptions cannot be changed to the free tier here. Revoke or cancel the paid subscription through the provider-aware workflow first.');
  }
  if(String(target.id)===String(sub.plan_id))throw new Error('Choose a different plan.');

  if(subscriptionState.recurringProvider(sub)){
    const selectedId=String(sub.id||sub.subscription_id);
    const canonical=await planChange.currentRecurring(customerId,target);
    const canonicalId=String(canonical?.subscription_id||canonical?.id||'');
    if(!canonical||canonicalId!==selectedId){
      throw new Error('The selected recurring subscription is no longer the canonical billing subscription for this service. Refresh the customer and try again.');
    }
    const targetCurrency=String(sub.currency_snapshot||sub.currency||target.currency||'GBP').trim().toUpperCase();
    const result=await planChange.requestChange({
      customerId,targetPlanCode:target.code,targetCurrency,actorUserId
    });
    if(!result?.handled)throw new Error('The selected recurring subscription could not be changed through the provider-aware plan-change workflow.');
    let warning='';
    if(result.mode==='immediate'){
      try{await provisioning.reconcileCustomer(customerId);}
      catch(error){warning=` Provider billing changed successfully, but access reconciliation needs retry: ${clean(error.message||error,180)}`;}
    }
    return{message:`${result.message||`Plan change to ${target.name||target.code} accepted.`}${warning}`,mode:result.mode||'provider'};
  }

  const contract=await applyLocalPlanContract(sub,target);
  const warnings=[];
  try{
    await audit(actorUserId,'admin.customer.plan_change',customerId,{
      subscriptionId:sub.id||sub.subscription_id,planId:targetPlanId,targetCode:target.code,
      targetServiceType:target.service_type,currency:contract.price.currency,
      priceMinor:Number(contract.price.price_minor),contractSnapshotRefreshed:!contract.alreadyApplied,
      freeTier:contract.freeTier,providerBillingChanged:false,mode:'manual_entitlement',
      alreadyApplied:contract.alreadyApplied
    });
  }catch(error){warnings.push(`audit logging needs review: ${clean(error.message||error,140)}`);}
  try{await provisioning.reconcileCustomer(customerId);}
  catch(error){warnings.push(`access reconciliation needs retry: ${clean(error.message||error,180)}`);}
  const suffix=warnings.length?` Warning: ${warnings.join('; ')}`:'';
  return{message:`Subscription moved to ${target.name||target.code}.${suffix}`,mode:'manual'};
}


async function resetAutomaticPlacement(customerId,{actorUserId=null}={}){
  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
  if(!entitlement||!['jellyfin','bundle'].includes(String(entitlement.service_type_snapshot||entitlement.service_type||'jellyfin'))){
    throw new Error('This customer has no active Jellyfin entitlement to place.');
  }

  const[current,target]=await Promise.all([
    serverMigration.primaryAccount(customerId),
    provisioning.selectServerForPlan(entitlement)
  ]);
  if(!target)throw new Error('No eligible server is currently available for this plan.');

  if(!current){
    const outcome=await provisioning.reconcileCustomer(customerId);
    return{mode:'placed',targetName:outcome?.account?.server_name||target.name||null};
  }

  if(String(current.server_id)===String(target.id)){
    await provisioning.reconcileCustomer(customerId);
    return{mode:'already',targetName:target.name};
  }

  const migration=await serverMigration.createMigration(customerId,target.id,actorUserId);
  const moved=await serverMigration.executeMigration(migration.id);
  return{mode:'moved',targetName:moved?.target_server_name||target.name};
}

async function moveServer(customerId,serverId,{actorUserId=null}={}){
  return forceMove.move(customerId,serverId,{actorUserId});
}

module.exports={
  subscriptionForCustomer,
  targetPlan,
  lockSubscriptionForPlanChange,
  applyLocalPlanContract,
  changePlan,
  resetAutomaticPlacement,
  moveServer
};
