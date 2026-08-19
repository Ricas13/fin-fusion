'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');

function gate(req,res,next){return req.session?.customerUserId&&req.session?.customerId?next():res.redirect('/account/login?session=expired');}
function createCustomerMarketingPreferencesRouter(){
  const router=express.Router();
  router.post('/account/communications/marketing-email',gate,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    const enabled=req.body.enabled==='1';
    try{
      await query(`INSERT INTO customer_communication_preferences(customer_id,marketing_email_opt_in,marketing_email_opted_in_at,marketing_email_opted_out_at) VALUES($1,$2,CASE WHEN $2 THEN NOW() ELSE NULL END,CASE WHEN $2 THEN NULL ELSE NOW() END) ON CONFLICT(customer_id) DO UPDATE SET marketing_email_opt_in=EXCLUDED.marketing_email_opt_in,marketing_email_opted_in_at=CASE WHEN EXCLUDED.marketing_email_opt_in THEN COALESCE(customer_communication_preferences.marketing_email_opted_in_at,NOW()) ELSE customer_communication_preferences.marketing_email_opted_in_at END,marketing_email_opted_out_at=CASE WHEN EXCLUDED.marketing_email_opt_in THEN NULL ELSE NOW() END,updated_at=NOW()`,[req.session.customerId,enabled]);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.marketing_email.preference','customer',$2,$3::jsonb)`,[req.session.customerUserId,req.session.customerId,JSON.stringify({enabled})]);
      return res.redirect('/account/communications?message='+encodeURIComponent(enabled?'Marketing email enabled.':'Marketing email disabled.'));
    }catch(error){return res.redirect('/account/communications?error='+encodeURIComponent(error.message));}
  });
  return router;
}
module.exports={createCustomerMarketingPreferencesRouter};
