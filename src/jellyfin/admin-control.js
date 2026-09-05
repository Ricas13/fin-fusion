'use strict';

const {query,transaction}=require('../db');
const serviceAdminControl=require('../entitlements/service-admin-control');

function same(a,b){return String(a||'')===String(b||'');}

// Backward-compatible Jellyfin-scoped facade over the canonical, service-
// scoped src/entitlements/service-admin-control.js (customer_service_admin_control).
//
// Existing callers pass a subscriptionId because authority used to be keyed
// to one specific subscription row (customer_jellyfin_admin_control). That
// parameter is accepted here for source compatibility but is no longer part
// of the storage key: authority is now customer+service scoped, so an
// admin directive survives subscription churn (a plan change, a renewal, a
// new checkout after a payment failure) instead of silently stopping the
// moment the subscription it was recorded against is superseded.
async function state(customerId,subscriptionId,{client=null}={}){
  if(!customerId)return null;
  const row=await serviceAdminControl.state(customerId,'jellyfin',{client});
  if(!row)return null;
  return {...row,subscription_id:subscriptionId||null,forced_server_class:row.server_class,server_max_users:null};
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
    LEFT JOIN customer_service_admin_control ctl
      ON ctl.customer_id=s.customer_id AND ctl.service='jellyfin'
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

  if(control.mode==='admin_removed'){
    decorated.blocked=true;
    decorated.admin_jellyfin_mode='removed';
    decorated.admin_jellyfin_removed=true;
  }else if(control.mode==='admin_present'){
    decorated.blocked=false;
    decorated.admin_jellyfin_mode='present';
  }else if(control.mode==='admin_server_pin'&&control.server_id){
    decorated.blocked=false;
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
  if(!plan?.customer_id)return null;
  const result=await query(`
    SELECT js.*
    FROM customer_service_admin_control ctl
    JOIN jellyfin_servers js ON js.id=ctl.server_id
    WHERE ctl.customer_id=$1 AND ctl.service='jellyfin'
      AND ctl.mode='admin_server_pin'
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    LIMIT 1
  `,[plan.customer_id]);
  return result.rows[0]||null;
}

async function forceServer(customerId,subscriptionId,serverId,{actorUserId=null,reason=''}={}){
  const result=await serviceAdminControl.pinServer(customerId,serverId,{actorUserId,reason:reason||'Server selected explicitly by administrator'});
  const server=await query(`SELECT id,name,server_class,media_server_type,enabled,health_status,max_users FROM jellyfin_servers WHERE id=$1`,[result.serverId]);
  return server.rows[0]||null;
}

async function remove(customerId,subscriptionId,{actorUserId=null,reason=''}={}){
  await serviceAdminControl.setRemoved(customerId,'jellyfin',{actorUserId,reason:reason||'Jellyfin access removed explicitly by administrator'});
  return{mode:'removed',subscriptionId:subscriptionId||null};
}

async function clear(customerId,subscriptionId,{actorUserId=null,reason=''}={}){
  const result=await serviceAdminControl.clear(customerId,'jellyfin',{actorUserId,reason:reason||'Returned to automatic Jellyfin management'});
  if(!result.changed)return{changed:false};
  return{changed:true,previous:{mode:result.previous.mode,server_id:result.previous.server_id||null}};
}

async function isForcedTo(customerId,subscriptionId,serverId){
  const current=await state(customerId,subscriptionId);
  return Boolean(current?.mode==='admin_server_pin'&&same(current.server_id,serverId));
}

module.exports={state,entitlementSemantics,forcedServerForPlan,forceServer,remove,clear,isForcedTo};
