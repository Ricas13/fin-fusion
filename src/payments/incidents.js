'use strict';

const { query, transaction } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const provisioning = require('../jellyfin/resilient-provisioning');
const providerReconciliation = require('./incident-reconciliation');

const POLICY_KEY = 'payment_risk_policy';
const DEFAULTS = Object.freeze({ refundAction:'preserve',disputeAction:'suspend',chargebackAction:'suspend',failedRenewalAction:'provider_state' });
function cleanAction(value,allowed,fallback){return allowed.includes(String(value||''))?String(value):fallback}
async function policy(){const result=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[POLICY_KEY]);const value=result.rows[0]?.setting_value||{};return{refundAction:cleanAction(value.refundAction,['preserve','suspend_full_refund'],DEFAULTS.refundAction),disputeAction:cleanAction(value.disputeAction,['preserve','suspend'],DEFAULTS.disputeAction),chargebackAction:cleanAction(value.chargebackAction,['preserve','suspend'],DEFAULTS.chargebackAction),failedRenewalAction:'provider_state'}}
async function savePolicy(input,actorUserId=null){const value={refundAction:cleanAction(input.refundAction,['preserve','suspend_full_refund'],DEFAULTS.refundAction),disputeAction:cleanAction(input.disputeAction,['preserve','suspend'],DEFAULTS.disputeAction),chargebackAction:cleanAction(input.chargebackAction,['preserve','suspend'],DEFAULTS.chargebackAction),failedRenewalAction:'provider_state'};await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[POLICY_KEY,JSON.stringify(value)]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_risk_policy.update','platform_setting',$2,$3::jsonb)`,[actorUserId,POLICY_KEY,JSON.stringify(value)])});return value}
async function identityFromProviderSubscription(provider,providerSubscriptionId){if(!providerSubscriptionId)return{scope:'unresolved',customerId:null};const direct=await query(`SELECT customer_id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 ORDER BY created_at DESC LIMIT 1`,[provider,providerSubscriptionId]);if(direct.rowCount)return{scope:'direct',customerId:direct.rows[0].customer_id};return{scope:'unresolved',customerId:null}}
async function identityFromMetadata(metadata={}){if(metadata.internal_customer_id)return{scope:'direct',customerId:metadata.internal_customer_id};return{scope:'unresolved',customerId:null}}
async function reconcileMany(ids){for(const id of ids){try{await provisioning.reconcileCustomer(id)}catch(error){console.warn(`Payment incident reconcile failed for customer ${id}:`,error.message)}}}
function holdSource(provider,caseId){return `${provider}:${String(caseId||'').slice(0,170)}`}
async function applyHold(identity,provider,caseId,reason){const sourceKey=holdSource(provider,caseId),ids=identity.scope==='direct'&&identity.customerId?[identity.customerId]:[];for(const customerId of ids)await accessHolds.addHold({customerId,type:'payment_risk',sourceKey,reason,metadata:{provider,caseId,scope:identity.scope}});await reconcileMany(ids);return ids.length}
async function releaseHold(identity,provider,caseId){const sourceKey=holdSource(provider,caseId),ids=identity.scope==='direct'&&identity.customerId?[identity.customerId]:[];for(const customerId of ids)await accessHolds.releaseHold({customerId,type:'payment_risk',sourceKey});await reconcileMany(ids);return ids.length}
function policyAction(kind,cfg,metadata){if(kind==='checkout_completion')return'preserve';if(kind==='refund')return cfg.refundAction==='suspend_full_refund'&&metadata?.fullRefund===true?'suspend':'preserve';if(kind==='dispute')return cfg.disputeAction;if(kind==='chargeback')return cfg.chargebackAction;return cfg.failedRenewalAction}
async function record({provider,eventId,caseId=null,kind,status='open',identity=null,providerSubscriptionId=null,amountMinor=null,currency=null,metadata={}}){
  if(!['stripe','paypal','plisio'].includes(provider))throw new Error('Unsupported incident provider.');
  if(!['refund','dispute','chargeback','failed_renewal','checkout_completion'].includes(kind))throw new Error('Unsupported payment incident type.');
  const resolvedIdentity=identity||await identityFromProviderSubscription(provider,providerSubscriptionId),cfg=await policy();
  let action=policyAction(kind,cfg,metadata);if(status==='won')action='restore';else if(status==='resolved')action='preserve';
  const selected=await query(`
    WITH inserted AS (
      INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(provider,provider_event_id,incident_type) DO NOTHING
      RETURNING *,FALSE AS duplicate
    ), existing AS (
      SELECT pi.*,TRUE AS duplicate
      FROM payment_incidents pi
      WHERE pi.provider=$1 AND pi.provider_event_id=$2 AND pi.incident_type=$4
      LIMIT 1
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT * FROM existing WHERE NOT EXISTS(SELECT 1 FROM inserted)
    LIMIT 1
  `,[provider,String(eventId),caseId?String(caseId):null,kind,status,resolvedIdentity.scope||'unresolved',resolvedIdentity.customerId||null,providerSubscriptionId||null,amountMinor==null?null:Number(amountMinor),currency?String(currency).toUpperCase().slice(0,3):null,action,JSON.stringify(metadata||{})]);
  let incident=selected.rows[0];
  if(!incident)throw new Error('Payment incident could not be recorded or reloaded.');
  if(incident.scope==='unresolved'&&resolvedIdentity.scope!=='unresolved'&&resolvedIdentity.customerId){
    const upgraded=await query(`UPDATE payment_incidents SET scope=$2,customer_id=COALESCE(customer_id,$3),provider_subscription_id=COALESCE(provider_subscription_id,$4),metadata=COALESCE(metadata,'{}'::jsonb)||$5::jsonb,updated_at=NOW() WHERE id=$1 AND scope='unresolved' RETURNING *`,[incident.id,resolvedIdentity.scope,resolvedIdentity.customerId,providerSubscriptionId||null,JSON.stringify(metadata||{})]);
    if(upgraded.rowCount)incident={...upgraded.rows[0],duplicate:incident.duplicate};
  }
  const effectiveAction=incident.access_action||action;
  let effectIdentity=incident.scope==='unresolved'&&resolvedIdentity.scope!=='unresolved'
    ? resolvedIdentity
    : {scope:incident.scope||resolvedIdentity.scope||'unresolved',customerId:incident.customer_id||resolvedIdentity.customerId||null};
  let affected=0;
  if(effectiveAction==='suspend'&&incident.provider_case_id&&effectIdentity.scope!=='unresolved')affected=await applyHold(effectIdentity,provider,incident.provider_case_id,`${provider} ${kind} is under review`);
  else if(effectiveAction==='restore'&&incident.provider_case_id){
    if(effectIdentity.scope==='unresolved'){
      const prior=await query(`SELECT scope,customer_id FROM payment_incidents WHERE provider=$1 AND provider_case_id=$2 AND access_action='suspend' ORDER BY created_at LIMIT 1`,[provider,String(incident.provider_case_id)]);
      if(prior.rowCount)effectIdentity={scope:prior.rows[0].scope,customerId:prior.rows[0].customer_id};
    }
    if(effectIdentity.scope!=='unresolved')affected=await releaseHold(effectIdentity,provider,incident.provider_case_id);
  }
  return{duplicate:Boolean(incident.duplicate),incident,affected};
}
async function get(id){const r=await query(`SELECT * FROM payment_incidents WHERE id=$1`,[id]);return r.rows[0]||null}
async function acknowledge(id,actorUserId){const r=await query(`UPDATE payment_incidents SET acknowledged_at=COALESCE(acknowledged_at,NOW()),acknowledged_by=COALESCE(acknowledged_by,$2),updated_at=NOW() WHERE id=$1 RETURNING *`,[id,actorUserId]);if(!r.rowCount)throw new Error('Payment incident not found.');await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_incident.acknowledge','payment_incident',$2,'{}'::jsonb)`,[actorUserId,id]);return r.rows[0]}
async function assign(id,assigneeUserId,actorUserId){if(assigneeUserId){const staff=await query(`SELECT id FROM app_users WHERE id=$1 AND role='admin' AND active=TRUE`,[assigneeUserId]);if(!staff.rowCount)throw new Error('Assignee must be an active administrator.')}const r=await query(`UPDATE payment_incidents SET assigned_to=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,assigneeUserId||null]);if(!r.rowCount)throw new Error('Payment incident not found.');await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_incident.assign','payment_incident',$2,$3::jsonb)`,[actorUserId,id,JSON.stringify({assignedTo:assigneeUserId||null})]);return r.rows[0]}
async function addNote(id,note,actorUserId){const clean=String(note||'').trim();if(!clean||clean.length>4000)throw new Error('Enter a note between 1 and 4000 characters.');const r=await query(`INSERT INTO payment_incident_notes(incident_id,actor_user_id,note) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM payment_incidents WHERE id=$1) RETURNING *`,[id,actorUserId,clean]);if(!r.rowCount)throw new Error('Payment incident not found.');await acknowledge(id,actorUserId);return r.rows[0]}
function restoreEvidenceAllowed(incident,reconciled){if(incident?.incident_type==='checkout_completion')throw new Error('Checkout-completion incidents are resolved by replaying/reconciling the provider callback, not by restoring access manually.');if(!reconciled?.match)throw new Error('Provider verification did not match this incident to a local subscription. Access was not restored.');if(incident.incident_type==='refund')throw new Error('A refund incident cannot restore paid access by local override. Verify an active paid agreement through billing reconciliation instead.');const snapshot=reconciled.snapshot||{};if(snapshot.restoreEligible!==true){const status=String(snapshot.providerStatus||'unknown'),outcome=String(snapshot.providerOutcome||'unknown');throw new Error(`Current provider state does not prove recovery (${status} / ${outcome}). Access was not restored.`);}return true;}
async function resolve(id,{note='',restoreAccess=false}={},actorUserId=null){let incident=await get(id);if(!incident)throw new Error('Payment incident not found.');const clean=String(note||'').trim().slice(0,4000);let affected=0,providerEvidence=null;if(restoreAccess){providerEvidence=await providerReconciliation.reconcile(id,actorUserId);incident=await get(id);restoreEvidenceAllowed(incident,providerEvidence);if(incident.provider_case_id){const identity={scope:incident.scope,customerId:incident.customer_id};if(identity.scope!=='unresolved')affected=await releaseHold(identity,incident.provider,incident.provider_case_id)}}const r=await query(`UPDATE payment_incidents SET incident_status='resolved',resolved_at=NOW(),resolved_by=$2,resolution_note=$3,acknowledged_at=COALESCE(acknowledged_at,NOW()),acknowledged_by=COALESCE(acknowledged_by,$2),updated_at=NOW() WHERE id=$1 RETURNING *`,[id,actorUserId,clean||null]);await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_incident.resolve','payment_incident',$2,$3::jsonb)`,[actorUserId,id,JSON.stringify({restoreAccess:Boolean(restoreAccess),affected,providerVerified:Boolean(providerEvidence),restoreEligible:providerEvidence?.snapshot?.restoreEligible===true})]);return{incident:r.rows[0],affected}}
async function reopen(id,actorUserId){
  const r=await query(`UPDATE payment_incidents SET incident_status='open',resolved_at=NULL,resolved_by=NULL,resolution_note=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[id]);
  if(!r.rowCount)throw new Error('Payment incident not found.');
  const incident=r.rows[0],identity={scope:incident.scope,customerId:incident.customer_id};
  let affected=0;
  if(incident.access_action==='suspend'&&incident.provider_case_id&&identity.scope!=='unresolved'&&identity.customerId){
    affected=await applyHold(identity,incident.provider,incident.provider_case_id,`${incident.provider} ${incident.incident_type} was reopened for review`);
  }
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_incident.reopen','payment_incident',$2,$3::jsonb)`,[actorUserId,id,JSON.stringify({affected,reappliedSuspension:affected>0})]);
  return incident;
}
async function notes(id){const r=await query(`SELECT n.*,u.username actor_username FROM payment_incident_notes n LEFT JOIN app_users u ON u.id=n.actor_user_id WHERE n.incident_id=$1 ORDER BY n.created_at DESC`,[id]);return r.rows}
async function recent(limit=100){const result=await query(`SELECT pi.*,c.display_name customer_name,au.username assigned_username FROM payment_incidents pi LEFT JOIN customers c ON c.id=pi.customer_id LEFT JOIN app_users au ON au.id=pi.assigned_to ORDER BY pi.created_at DESC LIMIT $1`,[Math.max(1,Math.min(500,Number(limit)||100))]);return result.rows}
module.exports={policy,savePolicy,record,recent,get,acknowledge,assign,addNote,resolve,reopen,notes,identityFromProviderSubscription,identityFromMetadata,holdSource,restoreEvidenceAllowed};
