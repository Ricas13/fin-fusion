'use strict';
const {query}=require('../db');
const KEY='commerce_control_v1';
const DEFAULTS=Object.freeze({paused:false,reason:'',pausedAt:null,pausedBy:null});
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);const v=r.rows[0]?.setting_value||{};return{...DEFAULTS,...v,paused:v.paused===true};}
async function assertOpen(){const state=await get();if(state.paused){const reason=String(state.reason||'').trim();throw new Error(reason?`New purchases are temporarily paused: ${reason}`:'New purchases are temporarily paused. Existing paid access is unaffected.');}return state;}
module.exports={KEY,DEFAULTS,get,assertOpen};
