'use strict';
const {query,transaction}=require('../db');
const KEY='commerce_control_v1';
const DEFAULTS=Object.freeze({paused:false,reason:'',pausedAt:null,pausedBy:null});
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);const v=r.rows[0]?.setting_value||{};return{...DEFAULTS,...v,paused:v.paused===true};}
async function assertOpen(){const state=await get();if(state.paused){const reason=String(state.reason||'').trim();throw new Error(reason?`New purchases are temporarily paused: ${reason}`:'New purchases are temporarily paused. Existing paid access is unaffected.');}return state;}
async function setPaused({paused,reason='',actorUserId=null}){const value={paused:Boolean(paused),reason:String(reason||'').trim().slice(0,500),pausedAt:paused?new Date().toISOString():null,pausedBy:paused?actorUserId:null};await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[KEY,JSON.stringify(value)]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'platform_setting',$3,$4::jsonb)`,[actorUserId,paused?'admin.commerce.pause':'admin.commerce.resume',KEY,JSON.stringify({reason:value.reason})]);});return value;}
module.exports={KEY,DEFAULTS,get,assertOpen,setPaused};
