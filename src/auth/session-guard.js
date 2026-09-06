'use strict';
const auth=require('./service');
const customers=require('../customers');
const csrf=require('./csrf');

const SAFE_METHODS=new Set(['GET','HEAD','OPTIONS']);
function destroy(req){return new Promise(resolve=>{if(!req.session)return resolve();req.session.destroy(()=>resolve())})}

function csrfRequiredForAuthenticatedMutation(req,principal){
    const method=String(req.method||'GET').toUpperCase();
    if(SAFE_METHODS.has(method))return false;
    const requestPath=String(req.path||'');
    // Editable impersonation still carries the authenticated administrator's
    // browser session, so every unsafe /account mutation must pass the same
    // CSRF boundary before the later no-spend policy decides whether the action
    // is financially allowed. Never rely on route-local CSRF alone here.
    if(req.session?.impersonation&&requestPath.startsWith('/account'))return true;
    if(principal==='admin')return requestPath==='/admin'||requestPath.startsWith('/admin/');
    if(principal==='customer')return requestPath==='/account'||requestPath.startsWith('/account/');
    return false;
}
function continueAuthenticated(req,res,next,principal){
    return csrfRequiredForAuthenticatedMutation(req,principal)?csrf.requireCsrf(req,res,next):next();
}

async function guardSession(req,res,next){
    try{
        if(req.session?.adminId&&!req.session?.authUserId){delete req.session.adminId;delete req.session.userType;return next()}
        if(req.session?.authUserId&&req.session?.authRole==='admin'){
            const result=await auth.validateStaffSession(req);
            if(result.valid)return continueAuthenticated(req,res,next,'admin');
            await destroy(req);
            if(req.path.startsWith('/api/'))return res.status(401).json({success:false,error:'Session expired'});
            return res.redirect('/login?session=expired')
        }
        if(req.session?.customerUserId){
            const result=await customers.validateCustomerSession(req);
            if(result.valid)return continueAuthenticated(req,res,next,'customer');
            await destroy(req);
            if(req.path.startsWith('/api/'))return res.status(401).json({success:false,error:'Session expired'});
            return res.redirect('/account/login?session=expired')
        }
        return next()
    }catch(error){
        console.error('Session validation failed:',error.message);
        if(process.env.NODE_ENV==='production'&&(req.session?.authUserId||req.session?.customerUserId)){
            await destroy(req);
            return res.status(503).send('Authentication service unavailable')
        }
        return next(error)
    }
}
module.exports={guardSession,csrfRequiredForAuthenticatedMutation,continueAuthenticated};