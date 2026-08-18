'use strict';
const {query}=require('../db');
const defaults={
  account_policy:{publicRegistration:process.env.PUBLIC_REGISTRATION!=='false',requireEmailVerification:process.env.REQUIRE_EMAIL_VERIFICATION==='true',allowSelfServiceTrial:true}
};
async function getSetting(key){
  const fallback=defaults[key]||{};
  const result=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[key]);
  if(!result.rowCount)return {...fallback};
  const value=result.rows[0].setting_value;
  return {...fallback,...(value&&typeof value==='object'?value:{})};
}
async function getAccountPolicy(){return getSetting('account_policy')}
module.exports={getSetting,getAccountPolicy};