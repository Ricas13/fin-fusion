'use strict';
const planCommands=require('../catalog/plan-command-service');
async function clonePlan(sourceId,input,actorUserId=null){return planCommands.clonePlanVersion(sourceId,input,actorUserId)}
module.exports={clonePlan};
