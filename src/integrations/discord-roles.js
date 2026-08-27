'use strict';
const {query}=require('../db');
const notificationSettings=require('./notification-settings');

async function managedRoleIds(){
  const r=await query(`SELECT DISTINCT discord_role_id FROM plans WHERE discord_role_id IS NOT NULL AND discord_role_id<>''`);
  return new Set(r.rows.map(row=>row.discord_role_id));
}
async function desiredRoleIdsForPlans(planIds){
  const ids=[...new Set((planIds||[]).filter(Boolean))];
  if(!ids.length)return new Set();
  const r=await query(`SELECT DISTINCT discord_role_id FROM plans WHERE id=ANY($1::uuid[]) AND discord_role_id IS NOT NULL AND discord_role_id<>''`,[ids]);
  return new Set(r.rows.map(row=>row.discord_role_id));
}
async function customerDiscordUserId(customerId){
  const r=await query(`SELECT discord_user_id FROM customer_communication_preferences WHERE customer_id=$1 AND discord_user_id IS NOT NULL`,[customerId]);
  return r.rows[0]?.discord_user_id||null;
}
async function currentGuildRoles(guildId,discordUserId){
  try{
    const member=await notificationSettings.discordApi(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}`);
    return new Set(Array.isArray(member.roles)?member.roles:[]);
  }catch(error){
    if(/HTTP 404/.test(String(error.message)))return null;
    throw error;
  }
}
async function syncRoleForCustomer(customerId,activePlanIds=[]){
  const status=await notificationSettings.status();
  if(!status.discordConfigured||!status.discordGuildId)return{skipped:'not_configured'};
  const discordUserId=await customerDiscordUserId(customerId);
  if(!discordUserId)return{skipped:'not_linked'};
  const managed=await managedRoleIds();
  if(!managed.size)return{skipped:'no_roles_configured'};
  const desired=await desiredRoleIdsForPlans(activePlanIds);
  const current=await currentGuildRoles(status.discordGuildId,discordUserId);
  if(current===null)return{skipped:'not_guild_member'};
  const toAdd=[...desired].filter(id=>!current.has(id));
  const toRemove=[...managed].filter(id=>current.has(id)&&!desired.has(id));
  const result={added:[],removed:[],errors:[]};
  for(const roleId of toAdd){
    try{await notificationSettings.discordApi(`/guilds/${encodeURIComponent(status.discordGuildId)}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,{method:'PUT'});result.added.push(roleId);}
    catch(error){result.errors.push(`add ${roleId}: ${error.message}`);}
  }
  for(const roleId of toRemove){
    try{await notificationSettings.discordApi(`/guilds/${encodeURIComponent(status.discordGuildId)}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,{method:'DELETE'});result.removed.push(roleId);}
    catch(error){result.errors.push(`remove ${roleId}: ${error.message}`);}
  }
  return result;
}
module.exports={syncRoleForCustomer,managedRoleIds,desiredRoleIdsForPlans};
