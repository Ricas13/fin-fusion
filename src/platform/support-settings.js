'use strict';
const {query,transaction}=require('../db');
const KEY='support_links_v1';
const DEFAULTS=Object.freeze({supportEmail:'',supportUrl:'',termsUrl:'',privacyUrl:'',refundUrl:'',statusUrl:''});
function url(value,label){const raw=String(value||'').trim();if(!raw)return'';let parsed;try{parsed=new URL(raw);}catch{throw new Error(`${label} must be a valid http/https URL.`);}if(!['http:','https:'].includes(parsed.protocol))throw new Error(`${label} must use http or https.`);if(parsed.username||parsed.password)throw new Error(`${label} may not contain credentials.`);return parsed.toString();}
function email(value){const raw=String(value||'').trim().toLowerCase();if(!raw)return'';if(raw.length>254||!raw.includes('@'))throw new Error('Support email is not valid.');return raw;}
function normalize(input={}){return{supportEmail:email(input.supportEmail),supportUrl:url(input.supportUrl,'Support URL'),termsUrl:url(input.termsUrl,'Terms URL'),privacyUrl:url(input.privacyUrl,'Privacy URL'),refundUrl:url(input.refundUrl,'Refund policy URL'),statusUrl:url(input.statusUrl,'Status page URL')};}
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);return{...DEFAULTS,...normalize(r.rows[0]?.setting_value||{})};}
async function save(input,actorUserId=null){const value=normalize(input);await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[KEY,JSON.stringify(value)]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.support_links.update','platform_setting',$2,$3::jsonb)`,[actorUserId,KEY,JSON.stringify(value)]);});return value;}
module.exports={KEY,DEFAULTS,normalize,get,save};
