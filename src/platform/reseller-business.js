'use strict';
const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const settings=require('../resellers/settings');
const productReadiness=require('./product-readiness');
const {createResellerServiceAwarePortalRouter}=require('./reseller-service-aware-portal');
const runtimeSettings=require('./runtime-settings');
const branding=require('./branding');
const {esc}=require('./admin-html');
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired')}
function noStore(_q,res,next){res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');next()}
async function owner(userId){const r=await query(`SELECT r.id,u.username,u.email FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.user_id=$1`,[userId]);if(!r.rowCount)throw new Error('Reseller not found.');return r.rows[0]}
function shell(site,title,body){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><link rel="stylesheet" href="/css/customer-360.css"><style>body{background:#0c1117}.wrap{max-width:1000px;margin:auto;padding:24px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center}.nav{display:flex;gap:7px;flex-wrap:wrap}</style></head><body><main class="wrap"><header class="top"><a href="/reseller"><strong>${esc(site)} · Reseller</strong></a><nav class="nav"><a class="button secondary btn-sm" href="/reseller">Dashboard</a><a class="button secondary btn-sm" href="/reseller/ledger">Ledger</a><a class="button secondary btn-sm" href="/reseller/security">Security</a></nav></header>${body}</main></body></html>`}
function requestPath(req){try{return new URL(String(req.originalUrl||req.url||'/'),'http://captainfin.invalid').pathname}catch{return String(req.path||'')}}
async function stremioCredentialGuard(req,res,next){
  if(req.session?.authRole!=='reseller')return next();
  const path=requestPath(req),match=path.match(/^\/reseller\/customer\/([^/]+)\/credentials(?:\/reset)?$/);if(!match)return next();
  try{
    const reseller=await owner(req.session.authUserId),result=await query(`SELECT COALESCE(s.service_type_snapshot,p.service_type,'jellyfin') service_type FROM customers c LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE customer_id=c.id AND superseded_by IS NULL ORDER BY current_period_end DESC,created_at DESC LIMIT 1)s ON TRUE LEFT JOIN plans p ON p.id=s.plan_id WHERE c.id=$1 AND c.reseller_id=$2 LIMIT 1`,[match[1],reseller.id]);
    if(!result.rowCount)return next();
    if(productReadiness.serviceType({service_type:result.rows[0].service_type})==='stremio')return res.redirect('/reseller?message='+encodeURIComponent('This customer uses Stremio only. Their private installation is managed from their own CAPTaINFiN portal; there is no reseller-visible Jellyfin password.'));
    return next();
  }catch(error){return next(error);}
}
async function saleReadinessGuard(req,res,next){
  if(req.method!=='POST'||req.session?.authRole!=='reseller'||!req.body?.planCode)return next();
  const path=requestPath(req);
  try{
    const {plan,readiness}=await productReadiness.assertSellableCode(req.body.planCode),delivery=productReadiness.serviceType(plan);
    if(['stremio','bundle'].includes(delivery)){
      const reseller=await owner(req.session.authUserId),cfg=await settings.forReseller(reseller.id);
      if(path==='/reseller/owner/create')throw new Error('Reseller owner access currently supports Jellyfin plans only. Create Stremio access as a customer with their own portal identity.');
      if(cfg.customerPortalPolicy==='jellyfin_only')throw new Error('Stremio delivery requires a customer portal account. Change Reseller Settings to Optional or Required portal accounts before selling this plan.');
      if(path==='/reseller/customer/create'&&cfg.customerPortalPolicy==='optional'&&req.body.createPortal!=='1')throw new Error('Select “Send this customer a CAPTaINFiN portal activation” before creating a Stremio or bundle customer.');
      const renewal=path.match(/^\/reseller\/customer\/([^/]+)\/renew$/);
      if(renewal){const customer=await query('SELECT user_id FROM customers WHERE id=$1 AND reseller_id=$2',[renewal[1],reseller.id]);if(!customer.rowCount)throw new Error('Customer not found.');if(!customer.rows[0].user_id)throw new Error('This customer needs a CAPTaINFiN portal identity before switching to a Stremio or bundle plan.');}
    }
    req.commercialPlan=plan;req.commercialReadiness=readiness;return next();
  }catch(error){
    const match=path.match(/^\/reseller\/customer\/([^/]+)\/renew$/),target=match?`/reseller/customer/${encodeURIComponent(match[1])}/renew`:'/reseller';
    return res.redirect(`${target}?error=${encodeURIComponent(error.message||'This customer plan is not available.')}`);
  }
}
async function page(req){await runtimeSettings.ensureLoaded();const r=await owner(req.session.authUserId),cfg=await settings.forReseller(r.id),body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<section class="section"><div class="sectionHead"><div><h2>Business identity</h2><div class="muted">Used on printable downstream sale receipts. It does not change CAPTaINFiN's own merchant/provider identity.</div></div></div><form class="formPanel" method="post" action="/reseller/settings"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Legal / trading name</label><input class="input" name="legalName" maxlength="200" value="${esc(cfg.legalName)}"></div><div class="formGroup"><label>Tax / VAT ID</label><input class="input" name="taxId" maxlength="120" value="${esc(cfg.taxId)}"></div><div class="formGroup"><label>Receipt prefix</label><input class="input" name="receiptPrefix" maxlength="20" pattern="[A-Za-z0-9-]{0,20}" value="${esc(cfg.receiptPrefix)}" placeholder="CF"></div></div><div class="formGroup"><label>Invoice / receipt address</label><textarea class="input" name="invoiceAddress" maxlength="1000">${esc(cfg.invoiceAddress)}</textarea></div><h3>Customer portal policy</h3><div class="formGroup"><select class="input" name="customerPortalPolicy"><option value="jellyfin_only" ${cfg.customerPortalPolicy==='jellyfin_only'?'selected':''}>Jellyfin-only customers</option><option value="optional" ${cfg.customerPortalPolicy==='optional'?'selected':''}>Optional portal account per customer</option><option value="portal_required" ${cfg.customerPortalPolicy==='portal_required'?'selected':''}>Every new customer gets a portal activation</option></select><div class="inlineHelp">Portal accounts let downstream customers manage their own portal password/security and see the access assigned by you. Stremio and bundle products require a customer portal account so the customer can control their private install URL.</div></div><button class="button">Save reseller settings</button></form></section>`;return shell(runtimeSettings.siteName(),'Reseller settings',body)}
function createResellerBusinessRouter(){const r=express.Router();r.use('/reseller',stremioCredentialGuard,saleReadinessGuard);r.use(createResellerServiceAwarePortalRouter());r.use('/reseller/settings',gate,noStore);r.get('/reseller/settings',async(req,res,next)=>{try{return res.send(await page(req))}catch(e){next(e)}});r.post('/reseller/settings',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await owner(req.session.authUserId),policy=['jellyfin_only','optional','portal_required'].includes(req.body.customerPortalPolicy)?req.body.customerPortalPolicy:'optional',prefix=String(req.body.receiptPrefix||'').trim().toUpperCase();if(prefix&&!/^[A-Z0-9-]{1,20}$/.test(prefix))throw new Error('Receipt prefix may use letters, numbers and hyphens.');await query(`UPDATE resellers SET legal_name=$2,tax_id=$3,invoice_address=$4,receipt_prefix=$5,customer_portal_policy=$6 WHERE id=$1`,[reseller.id,String(req.body.legalName||'').trim().slice(0,200)||null,String(req.body.taxId||'').trim().slice(0,120)||null,String(req.body.invoiceAddress||'').trim().slice(0,1000)||null,prefix||null,policy]);await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'reseller.business_settings.update','reseller',$2,$3::jsonb)`,[req.session.authUserId,reseller.id,JSON.stringify({portalPolicy:policy,hasLegalName:Boolean(req.body.legalName),hasTaxId:Boolean(req.body.taxId)})]);return res.redirect('/reseller/settings?message='+encodeURIComponent('Reseller business settings saved.'))}catch(e){return res.redirect('/reseller/settings?error='+encodeURIComponent(e.message))}});return r}
module.exports={createResellerBusinessRouter,page,owner,shell,saleReadinessGuard,stremioCredentialGuard,requestPath};
