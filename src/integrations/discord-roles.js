'use strict';
const {query}=require('../db');
const notificationSettings=require('./notification-settings');

const DISCORD_ADMINISTRATOR=8n;
const DISCORD_MANAGE_ROLES=268435456n;
const CATALOGUE_TTL_MS=60*1000;
let catalogueCache=null;

function snowflake(value){const text=String(value||'').trim();return /^\d{15,24}$/.test(text)?text:null;}
function permissionBits(value){try{return BigInt(String(value||'0'));}catch(_){return 0n;}}
function rolePosition(role){const value=Number(role?.position);return Number.isFinite(value)?value:0;}
function compactError(error){const message=String(error?.message||error||'Discord request failed').replace(/\s+/g,' ').trim();return message.replace(/: \{[\s\S]*$/,'').slice(0,180);}

function analyzeGuildRoles({guildId,bot,member,roles}={}){
  const guild=snowflake(guildId);
  const botId=snowflake(bot?.id);
  const all=Array.isArray(roles)?roles.filter(role=>snowflake(role?.id)).map(role=>({
    id:String(role.id),
    name:String(role.name||'Unnamed role').slice(0,120),
    position:rolePosition(role),
    managed:Boolean(role.managed),
    permissions:String(role.permissions||'0')
  })):[];
  if(!guild||!botId)return{ready:false,reason:'invalid_identity',roles:[],assignableRoles:[],botHighestPosition:0,hasManageRoles:false};

  const memberRoleIds=new Set(Array.isArray(member?.roles)?member.roles.map(String):[]);
  const everyone=all.find(role=>role.id===guild)||null;
  const botRoles=all.filter(role=>memberRoleIds.has(role.id));
  const botHighestPosition=botRoles.reduce((max,role)=>Math.max(max,role.position),everyone?.position||0);
  let permissions=permissionBits(everyone?.permissions);
  for(const role of botRoles)permissions|=permissionBits(role.permissions);
  const hasManageRoles=(permissions&DISCORD_ADMINISTRATOR)!==0n||(permissions&DISCORD_MANAGE_ROLES)!==0n;

  const normalized=all
    .filter(role=>role.id!==guild)
    .map(role=>({
      id:role.id,
      name:role.name,
      position:role.position,
      managed:role.managed,
      assignable:hasManageRoles&&!role.managed&&role.position<botHighestPosition,
      reason:role.managed?'managed_by_discord':!hasManageRoles?'missing_manage_roles':role.position>=botHighestPosition?'above_bot_role':null
    }))
    .sort((a,b)=>b.position-a.position||a.name.localeCompare(b.name));
  const assignableRoles=normalized.filter(role=>role.assignable);
  const reason=!hasManageRoles?'missing_manage_roles':botHighestPosition<=0?'bot_role_hierarchy':assignableRoles.length?'ready':'no_assignable_roles';
  return{
    ready:reason==='ready',
    reason,
    guildId:guild,
    botId,
    botName:String(bot?.username||bot?.global_name||botId).slice(0,120),
    botHighestPosition,
    hasManageRoles,
    roles:normalized,
    assignableRoles
  };
}

async function roleCatalogue({force=false}={}){
  const status=await notificationSettings.status();
  const guildId=snowflake(status.discordGuildId);
  if(!status.discordConfigured)return{ready:false,reason:'bot_not_configured',roles:[],assignableRoles:[],guildId:guildId||null};
  if(!guildId)return{ready:false,reason:'guild_not_configured',roles:[],assignableRoles:[],guildId:null};
  const cacheKey=`${guildId}:${status.updatedAt||status.source||''}`;
  if(!force&&catalogueCache&&catalogueCache.key===cacheKey&&Date.now()-catalogueCache.at<CATALOGUE_TTL_MS)return catalogueCache.value;
  try{
    const [bot,roles]=await Promise.all([
      notificationSettings.discordApi('/users/@me'),
      notificationSettings.discordApi(`/guilds/${encodeURIComponent(guildId)}/roles`)
    ]);
    if(!snowflake(bot?.id))throw new Error('Discord did not return the bot identity.');
    const member=await notificationSettings.discordApi(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(bot.id)}`);
    const value=analyzeGuildRoles({guildId,bot,member,roles});
    catalogueCache={key:cacheKey,at:Date.now(),value};
    return value;
  }catch(error){
    const value={ready:false,reason:'discord_unavailable',roles:[],assignableRoles:[],guildId,error:compactError(error)};
    catalogueCache={key:cacheKey,at:Date.now(),value};
    return value;
  }
}

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
async function deletionInProgress(customerId){
  const r=await query(`SELECT 1 FROM customer_deletion_jobs WHERE customer_id=$1 AND status IN ('pending','running','failed') LIMIT 1`,[customerId]);
  return r.rowCount>0;
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
  // A destructive deletion hold is authoritative. Generic role reconciliation
  // may help remove access, but it must never re-add a managed role while the
  // durable deletion saga is retaining this identity for strict cleanup.
  const deleting=await deletionInProgress(customerId);
  const desired=deleting?new Set():await desiredRoleIdsForPlans(activePlanIds);
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
module.exports={syncRoleForCustomer,managedRoleIds,desiredRoleIdsForPlans,customerDiscordUserId,deletionInProgress,currentGuildRoles,roleCatalogue,analyzeGuildRoles,snowflake,compactError,DISCORD_ADMINISTRATOR,DISCORD_MANAGE_ROLES};
