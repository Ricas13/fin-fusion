'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const billingControl = require('../payments/billing-control');
const planChange = require('../payments/customer-plan-change');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'))}
function guard(req,res,next){if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');return next()}
function redirect(res,key,message){return res.redirect(`/account?${key}=${encodeURIComponent(message)}`)}

async function currentRecurringOwned(customerId) {
    const current = await planChange.currentRecurring(customerId);
    if (!current) throw new Error('No active recurring subscription was found.');
    return current;
}

function createCustomerSubscriptionActionsRouter(){
    const r=express.Router();
    r.use('/account/subscription',requireCustomer);
    r.use('/account/plan-change',requireCustomer);

    r.post('/account/subscription/renewal',guard,async(req,res)=>{
        try{
            const current=await currentRecurringOwned(req.session.customerId),enable=String(req.body.action||'')==='resume';
            if(!['stop','resume'].includes(String(req.body.action||'')))throw new Error('Unknown renewal action.');
            await billingControl.setRenewal(current.subscription_id||current.id,enable,req.session.customerUserId);
            return redirect(res,'message',enable?'Automatic renewal resumed.':'Automatic renewal stopped. Your paid access remains active until the current period ends.');
        }catch(error){return redirect(res,'error',error.message||'Renewal could not be changed.');}
    });

    r.post('/account/plan-change/cancel',guard,async(req,res)=>{
        try{
            const cancelled=await transaction(async client=>{
                const pending=await client.query(`SELECT id,target_plan_id,effective_at FROM customer_plan_changes WHERE customer_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[req.session.customerId]);
                if(!pending.rowCount)throw new Error('There is no pending plan change to cancel.');
                await client.query(`UPDATE customer_plan_changes SET state='cancelled',updated_at=NOW() WHERE id=$1`,[pending.rows[0].id]);
                await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.plan_change.cancel','customer',$2,$3::jsonb)`,[req.session.customerUserId,req.session.customerId,JSON.stringify({changeId:pending.rows[0].id,targetPlanId:pending.rows[0].target_plan_id,effectiveAt:pending.rows[0].effective_at})]);
                return pending.rows[0];
            });
            return redirect(res,'message',`Scheduled plan change cancelled${cancelled.effective_at?` before ${new Date(cancelled.effective_at).toLocaleDateString('en-GB')}`:''}.`);
        }catch(error){return redirect(res,'error',error.message||'Plan change could not be cancelled.');}
    });
    return r;
}

module.exports={createCustomerSubscriptionActionsRouter,currentRecurringOwned};
