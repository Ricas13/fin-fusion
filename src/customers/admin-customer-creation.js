'use strict';

const {query,transaction}=require('../db');
const accountCommands=require('../security/customer-account-provisioning');
const manualSubscriptions=require('../entitlements/manual-subscriptions');
const planCapacity=require('../entitlements/plan-capacity');
const customerServerChoice=require('../jellyfin/customer-server-choice');

async function create({
  username,
  email,
  displayName,
  planCode,
  provisioningMode,
  passwordHash,
  actorUserId=null
}){
  return transaction(async client=>{
    let plan=null;
    if(provisioningMode!=='portal_only'){
      const found=await client.query(
        `SELECT * FROM plans
         WHERE code=$1
           AND active=TRUE
           AND archived_at IS NULL
           AND (effective_from IS NULL OR effective_from<=NOW())
           AND (effective_until IS NULL OR effective_until>NOW())
           AND audience IN('direct','both')
           AND COALESCE(is_addon,FALSE)=FALSE
           AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio')`,
        [planCode]
      );
      if(!found.rowCount)throw new Error('Choose an active standalone direct-customer plan.');
      plan=found.rows[0];
    }

    const user=await accountCommands.createPendingCustomerUserTx(client,{
      username,email,passwordHash
    });
    const customer=await client.query(
      `INSERT INTO customers(user_id,display_name,email,provisioning_mode)
       VALUES($1,$2,$3,$4)
       RETURNING id`,
      [user.id,displayName,email,provisioningMode]
    );

    let subscription=null;
    let mediaServer=null;
    let mediaLocation=null;
    if(plan){
      const mediaPlan=Boolean(customerServerChoice.mediaServerType(plan));
      const deferredMediaProvisioning=mediaPlan&&provisioningMode==='after_activation';
      const capacityState=deferredMediaProvisioning
        ?await planCapacity.usage(plan.id,(sql,params)=>client.query(sql,params),{
            households:plan.stremio_household_network_limit||null
          })
        :null;
      // Deferred admin creation intentionally allows a paid media entitlement
      // to exist before infrastructure is configured/healthy. That state is
      // reconciled after activation and remains operator-visible on failure.
      // Only the physical-server requirement is deferred: the product's own
      // customer limit remains authoritative so an admin cannot oversubscribe
      // a plan merely because its fleet has not been configured yet.
      if(deferredMediaProvisioning&&capacityState?.model==='fleet_users'&&Number(capacityState?.configuredServers||0)===0){
        await planCapacity.lockAndAssertLogicalMedia(client,plan.id,plan.name||'This plan');
      }else{
        await planCapacity.lockAndAssert(client,plan.id,plan.name||'This plan',{
          households:plan.stremio_household_network_limit||null
        });
      }
      if(mediaPlan){
        try{
          mediaServer=await customerServerChoice.selectServerForLocationLocked(plan,null,{
            db:(sql,params)=>client.query(sql,params),
            requireSelection:false
          });
          mediaLocation=mediaServer?.selected_location||customerServerChoice.locationLabel(mediaServer?.location);
        }catch(error){
          if(!(deferredMediaProvisioning&&error?.code==='MEDIA_LOCATION_UNAVAILABLE'))throw error;
          mediaServer=null;
          mediaLocation=null;
        }
      }

      const now=new Date();
      const days=Number(plan.duration_days||30);
      const end=new Date(now.getTime()+days*86400000);
      subscription=await manualSubscriptions.createManualSubscriptionTx(client,{
        customerId:customer.rows[0].id,
        planId:plan.id,
        startsAt:now,
        endsAt:end,
        actorUserId,
        source:'admin_grant',
        status:plan.billing_interval==='trial'?'trialing':'active',
        auditAction:'admin.customer.subscription.create',
        auditMetadata:{
          planCode:plan.code,
          serviceType:plan.service_type||null,
          activationRequired:true,
          provisioningMode,
          mediaServerId:mediaServer?.id||null,
          mediaLocation
        }
      });
      if(mediaServer){
        const assigned=await client.query(`
          UPDATE subscriptions
          SET media_server_id=$2,
              media_location_preference=$3,
              media_location_snapshot=$3,
              updated_at=NOW()
          WHERE id=$1 AND customer_id=$4
          RETURNING id
        `,[subscription.id,mediaServer.id,mediaLocation,customer.rows[0].id]);
        if(!assigned.rowCount)throw new Error('New customer subscription changed before its media-server reservation could be persisted.');
      }
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.customer.create','customer',$2,$3::jsonb)`,
      [actorUserId,customer.rows[0].id,JSON.stringify({
        planCode:plan?.code||null,
        serviceType:plan?.service_type||null,
        activationRequired:true,
        provisioningMode
      })]
    );

    return{
      userId:user.id,
      customerId:customer.rows[0].id,
      subscriptionId:subscription?.id||null,
      serviceType:plan?.service_type||null
    };
  });
}

async function setActivationDeadline(customerId,expiresAt){
  const result=await query(
    `UPDATE customers SET activation_deadline=$2,updated_at=NOW() WHERE id=$1 RETURNING id`,
    [customerId,expiresAt]
  );
  if(!result.rowCount)throw new Error('Customer not found.');
  return true;
}

module.exports={create,setActivationDeadline};
