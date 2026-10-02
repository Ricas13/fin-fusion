'use strict';

const manualSubscriptions=require('../entitlements/manual-subscriptions');

function cleanName(value,fallback){
  const name=String(value||'').trim().slice(0,100);
  return name||String(fallback||'Administrator').slice(0,100);
}

async function syncLinkedEmailTx(client,userId,email){
  const result=await client.query(
    `UPDATE customers SET email=$2,updated_at=NOW() WHERE user_id=$1 RETURNING id`,
    [userId,email]
  );
  return result.rowCount;
}

async function createPersonalMediaProfileTx(client,{
  userId,
  displayName='',
  planCode='',
  actorUserId=null
}){
  const user=(await client.query(
    `SELECT id,username,email FROM app_users WHERE id=$1 AND role='admin' FOR UPDATE`,
    [userId]
  )).rows[0];
  if(!user)throw new Error('Administrator account not found.');
  if(!user.email)throw new Error('Set your administrator email first.');

  const existing=await client.query(
    `SELECT id FROM customers WHERE user_id=$1 ORDER BY created_at LIMIT 1`,
    [userId]
  );
  if(existing.rowCount)return{customerId:existing.rows[0].id,existing:true};

  const plan=(await client.query(
    `SELECT * FROM plans
     WHERE code=$1
       AND active=TRUE
       AND archived_at IS NULL
       AND (effective_from IS NULL OR effective_from<=NOW())
       AND (effective_until IS NULL OR effective_until>NOW())
       AND audience IN ('direct','both')
       AND COALESCE(service_type,'jellyfin') IN ('jellyfin','bundle')`,
    [String(planCode||'').trim()]
  )).rows[0];
  if(!plan)throw new Error('Choose an active Jellyfin-capable customer plan.');

  const customer=(await client.query(
    `INSERT INTO customers(user_id,display_name,email,provisioning_mode,registration_source,note)
     VALUES($1,$2,$3,'immediate','admin_personal',$4)
     RETURNING id`,
    [
      user.id,
      cleanName(displayName,user.username),
      user.email,
      'Personal media profile linked to administrator account.'
    ]
  )).rows[0];

  const now=new Date();
  const days=Math.max(1,Number(plan.duration_days||30));
  const end=new Date(now.getTime()+days*86400000);
  await manualSubscriptions.createManualSubscriptionTx(client,{
    customerId:customer.id,
    planId:plan.id,
    startsAt:now,
    endsAt:end,
    actorUserId,
    source:'admin_grant',
    status:plan.billing_interval==='trial'?'trialing':'active',
    auditAction:'admin.profile.media.subscription.create',
    auditMetadata:{planCode:plan.code,rolePreserved:'admin'}
  });

  await client.query(
    `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
     VALUES($1,'admin.profile.media.create','customer',$2,$3::jsonb)`,
    [actorUserId,customer.id,JSON.stringify({planCode:plan.code,rolePreserved:'admin'})]
  );

  return{customerId:customer.id,existing:false};
}

module.exports={cleanName,syncLinkedEmailTx,createPersonalMediaProfileTx};
