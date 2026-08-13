'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const auth=require('../auth/service');
const {customer360}=require('./customer-360');

const TABS=new Set(['overview','subscription','access','payments','activity','downloads','requests','security','timeline']);

function gate(req,res,next){
    if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function text(v,max){return String(v||'').trim().slice(0,max)}
function bool(v){return v==='on'||v==='true'||v===true}
function tags(v){return [...new Set(String(v||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean).map(x=>x.slice(0,40)))].slice(0,20)}
function path(id,tab='overview'){return `/admin/users/${encodeURIComponent(id)}?tab=${encodeURIComponent(tab)}`}

function createAdminCustomer360Router(){
    const router=express.Router();
    router.use('/admin/users',gate,noStore);

    router.get('/admin/users/:customerId',async(req,res,next)=>{
        try{
            const detail=await customer360(req.params.customerId);
            if(!detail)return res.status(404).render('auth/message',{siteName:process.env.SITE_NAME||'CAPTAiNFiN',title:'Customer not found',message:'This managed customer does not exist.',link:'/admin/users',linkText:'Back to Customers'});
            const activeTab=TABS.has(String(req.query.tab||''))?String(req.query.tab):'overview';
            return res.render('admin/customer-detail-360',{
                siteName:process.env.SITE_NAME||'CAPTAiNFiN',
                activeTab,
                csrfToken:csrf.token(req),
                message:req.query.message||null,
                error:req.query.error||null,
                ...detail
            });
        }catch(error){return next(error)}
    });

    router.post('/admin/users/:customerId/profile',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            if(!(await auth.verifySecondFactor(req.session.authUserId,req.body.code,req)))throw new Error('verification');
            const displayName=text(req.body.displayName,100)||null;
            const phone=text(req.body.phone,40)||null;
            const country=text(req.body.countryCode,2).toUpperCase();
            if(country&&!/^[A-Z]{2}$/.test(country))throw new Error('validation');
            const timezone=text(req.body.timezone,80)||null;
            const referral=text(req.body.referralSource,120)||null;
            const registration=text(req.body.registrationSource,40)||null;
            const discordId=text(req.body.discordUserId,32)||null;
            if(discordId&&!/^\d{5,32}$/.test(discordId))throw new Error('discord');
            const discordUsername=text(req.body.discordUsername,100)||null;
            const note=text(req.body.note,2000);
            const nextTags=tags(req.body.tags);
            await query(`UPDATE customers SET display_name=$2,phone=$3,country_code=$4,timezone=$5,referral_source=$6,registration_source=$7,discord_user_id=$8,discord_username=$9,marketing_opt_in=$10,tags=$11,note=$12,updated_at=NOW() WHERE id=$1`,[
                req.params.customerId,displayName,phone,country||null,timezone,referral,registration,discordId,discordUsername,bool(req.body.marketingOptIn),nextTags,note
            ]);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.profile.update','customer',$2,$3::jsonb)`,[
                req.session.authUserId,req.params.customerId,JSON.stringify({fields:['display_name','phone','country_code','timezone','referral_source','registration_source','discord','marketing_opt_in','tags','note']})
            ]);
            return res.redirect(path(req.params.customerId,'overview')+'&message='+encodeURIComponent('Customer profile updated.'));
        }catch(error){
            const message=error.message==='verification'?'Verification failed.':error.message==='discord'?'Discord user ID must contain digits only.':error.code==='23505'?'That Discord user ID is already linked to another customer.':'Customer profile could not be updated safely.';
            return res.redirect(path(req.params.customerId,'overview')+'&error='+encodeURIComponent(message));
        }
    });

    router.use('/admin/users/:customerId',(error,_req,res,_next)=>{
        console.error('Customer 360 route error:',error.message);
        return res.status(500).render('auth/message',{siteName:process.env.SITE_NAME||'CAPTAiNFiN',title:'Customer unavailable',message:'The customer profile could not be loaded safely.',link:'/admin/users',linkText:'Back to Customers'});
    });
    return router;
}

module.exports={createAdminCustomer360Router,TABS};
