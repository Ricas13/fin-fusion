'use strict';

const {query,transaction}=require('../db');
const KEY='jellyfin_lifecycle_policy_v2';
const DEFAULTS=Object.freeze({enabled:true,dryRun:false,freeNoPlaybackDays:7});
function bool(v,fallback=false){if(v===undefined||v===null||v==='')return fallback;return v===true||['true','1','on','yes'].includes(String(v).toLowerCase());}
function days(v,fallback,min=1,max=3650){const n=Number.parseInt(v,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function normalize(value={}){return{enabled:bool(value.enabled,DEFAULTS.enabled),dryRun:bool(value.dryRun,DEFAULTS.dryRun),freeNoPlaybackDays:days(value.freeNoPlaybackDays,DEFAULTS.freeNoPlaybackDays)};}
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);return normalize({...DEFAULTS,...(r.rows[0]?.setting_value||{})});}
async function save(input,actorUserId=null){const value=normalize(input);await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[KEY,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.jellyfin.lifecycle_policy.update','platform_setting',NULL,$2::jsonb)`,[actorUserId,JSON.stringify({...value,settingKey:KEY,portalAccountPreserved:true,accountLifecycle:'enabled_or_deleted'})]);});return value;}
function noPlaybackOverride(plan){const raw=plan?.inactivity_policy||{};const n=Number.parseInt(raw.noPlaybackDays,10);return Number.isInteger(n)&&n>=1&&n<=3650?n:null;}
function categoryFor({serverClass=null,priceMinor=0}={}){if(String(serverClass||'').toLowerCase()==='free')return'free';return Number(priceMinor||0)>0?'paid':'free';}
function freeNoPlaybackDays(cfg,plan=null){const override=noPlaybackOverride(plan);return{days:override??cfg.freeNoPlaybackDays,source:override==null?'global':'plan'};}
module.exports={KEY,DEFAULTS,normalize,get,save,categoryFor,freeNoPlaybackDays,noPlaybackOverride};
