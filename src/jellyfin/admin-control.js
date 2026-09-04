'use strict';

const {query,transaction}=require('../db');

function note(value,fallback){return String(value||fallback||'Administrator override').trim().slice(0,500)||String(fallback||'Administrator override');}
function same(a,b){return String(a||'')===String(b||'');}

async function state(customerId,subscriptionId,{client=null}={}){
  if(!customerId||!subscriptionId)return null;
  const db=client||{query};
  const result=await db.query(`
    SELECT c.*,js.name AS server_name,js.server_class AS forced_server_class,
           js.enabled AS server_enabled,js.health_status AS server_health,
           js.max_users AS server_max_users
    FROM customer_jellyfin_admin_control c
    LEFT JOIN jellyfin_servers js ON js.id=c.server_id
    WHERE c.customer_id=$1 AND c.subscription_id=$2
    LIMIT 1
  `,[customerId,subscriptionId]);
  return result.rows[0]||null;
}

async function entitlementSemantics(entitlement,{client=null}={}){
  if(!entitlement?.customer_id||!entitlement?.subscription_id)return entitlement||null;
  const db=client||{query};
  const result=await db.query(`
    SELECT
      COALESCE(o.permanent_access,FALSE) AS permanent_access,
      o.revoked_at,
      ctl.mode,ctl.server_id,
      js.name AS forced_server_name,js.server_class AS forced_server_class,
      js.enabled AS forced_server_enabled,js.health_status AS forced_server_health
    FROM subscriptions s
    LEFT JOIN customer_entitlement_overrides o
      ON o.customer_id=s.customer_id AND o.subscription_id=s.id
    LEFT JOIN customer_jellyfin_admin_control ctl
      ON ctl.customer_id=s.customer_id AND ctl.subscription_id=s.id
    LEFT JOIN jellyfin_servers js ON js.id=ctl.server_id
    WHERE s.id=$1 AND s.customer_id=$2
    LIMIT 1
  `,[entitlement.subscription_id,entitlement.customer_id]);
  const control=result.rows[0]||{};
  const permanent=Boolean(control.permanent_access&&!control.revoked_at);
  const decorated={...entitlement,permanent_access:permanent};

  // Permanent means billing/expiry/inactivity cannot remove access. Explicit
  // administrator removal is still authoritative because it is another direct
  // operator command, not an automated lifecycle signal.
  if(permanent)decorated.blocked=false;

  if(control.mode==='removed'){
    decorated.blocked=true;
    decorated.admin_jellyfin_mode='removed';
    decorated.admin_jellyfin_removed=true;
  }else if(control.mode==='forced_server'&&control.server_id){
    decorated.admin_jellyfin_mode='forced_server';
    decorated.admin_forced_server_id=control.server_id;
    decorated.admin_forced_server_name=control.forced_server_name||null;
    decorated.admin_forced_server_enabled=control.forced_server_enabled;
    decorated.admin_forced_server_health=control.forced_server_health||null;
    // Reconciliation chooses existing lane accounts by server class. Treat the
    // selected server class as the placement class while the pin exists so a
    // deliberate cross-pool admin placement is not undone on the next worker.
    if(control.forced_server_class)decorated.server_class=control.forced_server_class;
  }
  return decorated;
}

async function forcedServerForPlan(plan){
  if(!plan?.customer_id||!plan?.subscription_id)return null;
  const result=await query(`
    SELECT js.*
    FROM customer_jellyfin_admin_control ctl
    JOIN jellyfin_servers js ON js.id=ctl.server_id
    WHERE ctl.customer_id=$1 AND ctl.subscription_id=$2
      AND ctl.mode='forced_server'
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    LIMIT 1
  `,[plan.customer_id,plan.subscription_id]);
  return result.rows[0]||null;
}

async function forceServer(customerId,subscriptionId,serverId,{actorUserId=null,reason=''}={}){
  const why=note(reason,'Server selected explicitly by administrator');
  return transaction(async client=>{
    const subscription=await client.query('SELECT id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[subscriptionId,customerId]);
    if(!subscription.rowCount)throw new Error('The selected entitlement no longer belongs to this customer.');
    const server=await client.query(`SELECT id,name,server_class,media_server_type,enabled,health_status,max_users FROM jellyfin_servers WHERE id=$1 FOR UPDATE`,[serverId]);
    if(!server.rowCount||String(server.rows[0].media_server_type||'jellyfin')!=='jellyfin')throw new Error('Choose a configured Jellyfin server.');
    await client.query(`
      INSERT INTO customer_jellyfin_admin_control(customer_id,subscription_id,mode,server_id,reason,created_by,updated_by,updated_at)
      VALUES($1,$2,'forced_server',$3,$4,$5,$5,NOW())
      ON CONFLICT(customer_id,subscription_id) DO UPDATE SET
        mode='forced_server',server_id=EXCLUDED.server_id,reason=EXCLUDED.reason,
        updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `,[customerId,subscriptionId,serverId,why,actorUserId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.jellyfin.force_server','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({subscriptionId,serverId,serverName:server.rows[0].name,serverClass:server.rows[0].server_class,serverEnabled:server.rows[0].enabled,serverHealth:server.rows[0].health_status,maxUsers:server.rows[0].max_users,reason:why})]);
    return server.rows[0];
  });
}

async function remove(customerId,subscriptionId,{actorUserId=null,reason=''}={}){
  const why=note(reason,'Jellyfin access removed explicitly by administrator');
  return transaction(async client=>{
    const subscription=await client.query('SELECT id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[subscriptionId,customerId]);
    if(!subscription.rowCount)throw new Error('The selected entitlement no longer belongs to this customer.');
    await client.query(`
      INSERT INTO customer_jellyfin_admin_control(customer_id,subscription_id,mode,server_id,reason,created_by,updated_by,updated_at)
      VALUES($1,$2,'removed',NULL,$3,$4,$4,NOW())
      ON CONFLICT(customer_id,subscription_id) DO UPDATE SET
        mode='removed',server_id=NULL,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `,[customerId,subscriptionId,why,actorUserId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.jellyfin.remove_override','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({subscriptionId,reason:why})]);
    return{mode:'removed',subscriptionId};
  });
}

async function clear(customerId,subscriptionId,{actorUserId=null,reason=''}={}){
  const why=note(reason,'Returned to automatic Jellyfin management');
  return transaction(async client=>{
    const previous=await client.query('SELECT * FROM customer_jellyfin_admin_control WHERE customer_id=$1 AND subscription_id=$2 FOR UPDATE',[customerId,subscriptionId]);
    if(!previous.rowCount)return{changed:false};
    await client.query('DELETE FROM customer_jellyfin_admin_control WHERE customer_id=$1 AND subscription_id=$2',[customerId,subscriptionId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.jellyfin.return_to_automatic','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({subscriptionId,previousMode:previous.rows[0].mode,previousServerId:previous.rows[0].server_id||null,reason:why})]);
    return{changed:true,previous:previous.rows[0]};
  });
}

async function isForcedTo(customerId,subscriptionId,serverId){
  const current=await state(customerId,subscriptionId);
  return Boolean(current?.mode==='forced_server'&&same(current.server_id,serverId));
}

module.exports={state,entitlementSemantics,forcedServerForPlan,forceServer,remove,clear,isForcedTo};
