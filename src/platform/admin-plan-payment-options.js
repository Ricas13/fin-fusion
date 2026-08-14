'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const { esc, layout } = require('./admin-html');
const { planById, planSubnav } = require('./admin-plans');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function csrfInput(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`}
function checked(v){return v==='on'||v==='1'||v===true}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}

async function mappings(planId){
    const result=await query(`SELECT provider,checkout_mode,external_id,active FROM plan_provider_prices WHERE plan_id=$1 ORDER BY provider,CASE checkout_mode WHEN 'payment' THEN 0 ELSE 1 END`,[planId]);
    const map=new Map(result.rows.map(row=>[`${row.provider}:${row.checkout_mode}`,row]));
    return map;
}

function modeCard(provider,mode,row,{externalRequired=false,label,help}){
    const key=`${provider}_${mode}`;
    return `<div class="serverCard"><div class="serverTop"><div><strong>${esc(label)}</strong><div class="subText">${esc(help)}</div></div><span class="pill ${row?'good':''}">${row?'Enabled':'Off'}</span></div><label class="toggleRow"><input type="checkbox" name="${key}_enabled" ${row?'checked':''}><span>Offer this option to customers</span></label>${externalRequired?`<div class="formGroup"><label>${provider==='stripe'?'Stripe Price ID':'PayPal Billing Plan ID'}</label><input class="input" name="${key}_external_id" value="${esc(row?.external_id||'')}" placeholder="${provider==='stripe'?'price_...':'P-...'}"><div class="inlineHelp">Required while this option is enabled.</div></div>`:'<div class="securityNote standalone">The one-time PayPal amount comes from this CAPTaINFiN plan price, so no separate PayPal Billing Plan ID is required.</div>'}</div>`;
}

async function page(req,plan){
    const map=await mappings(plan.id);
    const stripePayment=map.get('stripe:payment');
    const stripeSubscription=map.get('stripe:subscription');
    const paypalPayment=map.get('paypal:payment');
    const paypalSubscription=map.get('paypal:subscription');
    const pricing=`<section class="section"><div class="sectionHead"><div><h2>Pricing</h2><div class="muted">The same plan price is used for access duration. Save pricing separately from checkout options.</div></div></div><form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/commerce">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Price</label><input class="input" type="number" step="0.01" min="0" name="price" value="${(Number(plan.price_minor)/100).toFixed(2)}"></div><div class="formGroup"><label>Currency</label><input class="input" name="currency" maxlength="3" value="${esc(plan.currency)}"></div></div>${plan.audience!=='direct'?`<div class="formGrid"><div class="formGroup"><label>Reseller credit cost</label><input class="input" type="number" min="0" name="resellerCreditCost" value="${esc(plan.reseller_credit_cost??'')}"></div><div class="formGroup"><label>Reseller trial credit cost</label><input class="input" type="number" min="0" max="20" name="resellerTrialCreditCost" value="${esc(plan.reseller_trial_credit_cost??'')}"></div></div>`:''}<button class="button">Save pricing</button></form></section>`;
    const options=`<section class="section"><div class="sectionHead"><div><h2>Customer payment choices</h2><div class="muted">Enable one-time, recurring, or both. When both are enabled, the customer chooses before leaving CAPTaINFiN.</div></div></div><form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/payment-options">${csrfInput(req)}<h3>Stripe</h3><div class="serverGrid">${modeCard('stripe','payment',stripePayment,{externalRequired:true,label:'One-time payment',help:'Pay once for this plan duration; no automatic renewal.'})}${modeCard('stripe','subscription',stripeSubscription,{externalRequired:true,label:'Recurring subscription',help:'Automatic Stripe renewal until cancelled.'})}</div><h3 style="margin-top:22px">PayPal</h3><div class="serverGrid">${modeCard('paypal','payment',paypalPayment,{externalRequired:false,label:'One-time payment',help:'Pay once using a PayPal order for this CAPTaINFiN plan price.'})}${modeCard('paypal','subscription',paypalSubscription,{externalRequired:true,label:'Recurring subscription',help:'Automatic renewal using a PayPal Billing Plan.'})}</div><div class="buttonRow" style="margin-top:18px"><button class="button">Save payment choices</button></div></form></section>`;
    const tip=`<div class="securityNote standalone"><strong>Customer experience:</strong> if a provider has both options enabled, clicking Pay with Stripe/PayPal opens a CAPTaINFiN choice screen first: Pay once or Subscribe &amp; auto-renew.</div>`;
    return layout({siteName:process.env.SITE_NAME||'CAPTaINFiN',active:'plans',title:plan.name,subtitle:'Commerce',body:`${notice(req)}${planSubnav(plan.id,'commerce')}${pricing}${options}${tip}`});
}

function cleanExternal(value){return String(value||'').trim().slice(0,200)}

async function saveOption(client,planId,provider,mode,enabled,externalId){
    if(!enabled){await client.query('DELETE FROM plan_provider_prices WHERE plan_id=$1 AND provider=$2 AND checkout_mode=$3',[planId,provider,mode]);return;}
    if((provider==='stripe'||mode==='subscription')&&!externalId)throw new Error(`${provider==='stripe'?'Stripe':'PayPal'} ${mode==='payment'?'one-time':'subscription'} ID is required.`);
    await client.query(`
        INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode,active)
        VALUES($1,$2,$3,$4,TRUE)
        ON CONFLICT(plan_id,provider,checkout_mode)
        DO UPDATE SET external_id=EXCLUDED.external_id,active=TRUE,updated_at=NOW()
    `,[planId,provider,externalId||null,mode]);
}

function createAdminPlanPaymentOptionsRouter(){
    const router=express.Router();
    router.use('/admin/plans',gate,noStore);
    router.get('/admin/plans/:id/commerce',async(req,res,next)=>{try{const plan=await planById(req.params.id);if(!plan)return res.status(404).send('Plan not found');return res.send(await page(req,plan));}catch(error){return next(error);}});
    router.post('/admin/plans/:id/payment-options',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{
            const plan=await planById(req.params.id);if(!plan)throw new Error('Plan not found');
            const specs=[['stripe','payment'],['stripe','subscription'],['paypal','payment'],['paypal','subscription']];
            await transaction(async client=>{
                for(const [provider,mode] of specs){
                    const key=`${provider}_${mode}`;
                    await saveOption(client,plan.id,provider,mode,checked(req.body[`${key}_enabled`]),cleanExternal(req.body[`${key}_external_id`]));
                }
                await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.payment_options','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({stripe:{payment:checked(req.body.stripe_payment_enabled),subscription:checked(req.body.stripe_subscription_enabled)},paypal:{payment:checked(req.body.paypal_payment_enabled),subscription:checked(req.body.paypal_subscription_enabled)}})]);
            });
            return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/commerce?message=`+encodeURIComponent('Payment choices saved.'));
        }catch(error){
            return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/commerce?error=`+encodeURIComponent(error.message||'Payment choices could not be saved.'));
        }
    });

    // Compatibility handler for pre-029 forms/bookmarks. The legacy route used
    // ON CONFLICT(plan_id,provider), which no longer exists once a provider can
    // expose two checkout modes. Keeping this handler ahead of the old router
    // makes stale forms safe instead of failing with a PostgreSQL conflict error.
    router.post('/admin/plans/:id/provider',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{
            const plan=await planById(req.params.id);if(!plan)throw new Error('Plan not found');
            const provider=['stripe','paypal'].includes(req.body.provider)?req.body.provider:null;
            if(!provider)throw new Error('Unknown payment provider');
            const mode=req.body.checkoutMode==='subscription'?'subscription':'payment';
            const externalId=cleanExternal(req.body.externalId);
            await transaction(async client=>{
                if(externalId || (provider==='paypal'&&mode==='payment')) {
                    await saveOption(client,plan.id,provider,mode,true,externalId);
                } else {
                    await saveOption(client,plan.id,provider,mode,false,'');
                }
                await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.provider_mapping_compat','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({provider,mode,configured:Boolean(externalId)||(provider==='paypal'&&mode==='payment')})]);
            });
            return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/commerce?message=`+encodeURIComponent('Payment mapping updated.'));
        }catch(error){
            return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/commerce?error=`+encodeURIComponent(error.message||'Payment mapping could not be updated.'));
        }
    });
    return router;
}

module.exports={createAdminPlanPaymentOptionsRouter,mappings};
