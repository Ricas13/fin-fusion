'use strict';

// Compatibility facade. The lifecycle implementation moved to a reason-aware
// Jellyfin-only state machine. Existing imports keep working while portal
// customer identity remains outside every automated disable/delete path.
const lifecycle=require('./jellyfin-lifecycle');

async function getCleanup(){const s=await lifecycle.getSettings();return{enabled:s.enabled,dryRun:s.dryRun,deleteAfterDays:s.paidDeleteAfterDisabledDays,minimumObservationHours:s.minimumObservationHours,...s};}
async function saveCleanup(input,actorUserId=null){const prior=await lifecycle.getSettings();return lifecycle.saveSettings({...prior,...input,paidDeleteAfterDisabledDays:input.paidDeleteAfterDisabledDays??input.deleteAfterDays??prior.paidDeleteAfterDisabledDays},actorUserId);}
async function candidates(){const cfg=await lifecycle.getSettings();return lifecycle.freeCandidates(cfg);}
async function runPlanRules(options={}){const cfg=await lifecycle.getSettings();return lifecycle.enforceFree(cfg,options);}
async function cleanupCandidates(){return lifecycle.dueCandidates();}
async function runCleanup(options={}){const cfg=await lifecycle.getSettings();return lifecycle.deleteDue(cfg,options);}
async function restoreReturningCustomer(customerId){return lifecycle.restoreReturningCustomer(customerId);}
function normalize(){return{enabled:false,deprecated:true};}
async function get(){return normalize();}
async function save(){return normalize();}

module.exports={
  KEY:'customer_inactivity_policy_v1',CLEANUP_KEY:lifecycle.SETTINGS_KEY,
  DEFAULT_CLEANUP:lifecycle.DEFAULTS,normalize,get,save,
  getCleanup,saveCleanup,telemetryReady:lifecycle.telemetryReady,candidates,runPlanRules,
  cleanupCandidates,runCleanup,restoreReturningCustomer,run:lifecycle.run,
  getLifecycleSettings:lifecycle.getSettings,saveLifecycleSettings:lifecycle.saveSettings,preview:lifecycle.preview
};
