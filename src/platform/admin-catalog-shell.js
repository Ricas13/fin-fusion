'use strict';
const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const auth=require('../auth/service');
const {esc,layout}=require('./admin-html');

const BILLING_TERMS={
    trial:{label:'Trial',days:1},
    month:{label:'Monthly',days:30},
    '6_months':{label:'6 months',days:183},
    year:{label:'Yearly',days:365},
    custom:{label:'Custom duration',days:null}
};

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function send(res,o,status=200){return res.status(status).send(layout({siteName:process.env.SITE_NAME||'CAPTaINFiN',...o}))}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}
function b(v){return v==='on'||v==='true'||v===true}
function text(v,max){return String(v||'').trim().slice(0,max)}
function money(v){const raw=String(v??'').trim();if(!/^\d+(?:\.\d{1,2})?$/.test(raw))throw new Error('Enter a valid non-negative price with no more than two decimal places.');const amount=Number(raw);if(!Number.isFinite(amount)||amount<0||amount>100000)throw new Error('Price must be between 0 and 100,000.');return Math.round(amount*100)}
function nullableInt(v,min=0,max=100000,label='Value'){if(v===undefined||v===null||String(v).trim()==='')return null;const x=Number.parseInt(v,10);if(!Number.isInteger(x)||String(x)!==String(v).trim()||x<min||x>max)throw new Error(`${label} must be a whole number from ${min} to ${max}.`);return x}
function int(v,min,max,label){const x=Number.parseInt(v,10);if(!Number.isInteger(x)||String(x)!==String(v).trim()||x<min||x>max)throw new Error(`${label} must be a whole number from ${min} to ${max}.`);return x}
function selected(value,current){return value===current?'selected':''}
function checked(value){return value?'checked':''}

function planCreateInput(body={}){
    const code=text(body.code,50).toLowerCase();
    const name=text(body.name,80);
    const description=text(body.description,500);
    if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code))throw new Error('Code must be 2–50 characters using lowercase letters, numbers and hyphens.');
    if(!name)throw new Error('Enter a plan name.');

    const audience=['direct','reseller','both'].includes(body.audience)?body.audience:null;
    if(!audience)throw new Error('Choose who can use this plan.');
    const billing=Object.prototype.hasOwnProperty.call(BILLING_TERMS,body.billingInterval)?body.billingInterval:null;
    if(!billing)throw new Error('Choose a billing frequency.');
    const duration=BILLING_TERMS[billing].days??int(body.durationDays,1,3650,'Custom duration');
    const currency=text(body.currency,3).toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency))throw new Error('Currency must be a 3-letter code such as GBP, USD or EUR.');

    const resellerEnabled=audience==='reseller'||audience==='both';
    return{
        code,name,description,audience,billing,duration,
        priceMinor:money(body.price),currency,
        resellerCreditCost:resellerEnabled?nullableInt(body.resellerCreditCost,0,100000,'Regular reseller credit cost'):null,
        resellerTrialCreditCost:resellerEnabled?nullableInt(body.resellerTrialCreditCost,0,20,'Trial reseller credit cost'):null,
        serverClass:['premium','free','custom'].includes(body.serverClass)?body.serverClass:'premium',
        visible:b(body.visible),active:b(body.active),sortOrder:100
    };
}

async function createPlanRecord(plan,actorUserId=null){
    return transaction(async client=>{
        const created=await client.query(`
            INSERT INTO plans(
                code,name,description,audience,billing_interval,duration_days,
                price_minor,currency,reseller_credit_cost,reseller_trial_credit_cost,
                server_class,visible,active,sort_order,allow_remuxing,allow_remote_access
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE,TRUE)
            RETURNING *
        `,[
            plan.code,plan.name,plan.description,plan.audience,plan.billing,plan.duration,
            plan.priceMinor,plan.currency,plan.resellerCreditCost,plan.resellerTrialCreditCost,
            plan.serverClass,plan.visible,plan.active,plan.sortOrder
        ]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.plan.create','plan',$2,$3::jsonb)
        `,[actorUserId,created.rows[0].id,JSON.stringify({
            code:plan.code,name:plan.name,audience:plan.audience,
            billingInterval:plan.billing,durationDays:plan.duration,
            priceMinor:plan.priceMinor,currency:plan.currency,
            resellerCreditCost:plan.resellerCreditCost,
            resellerTrialCreditCost:plan.resellerTrialCreditCost
        })]);
        return created.rows[0];
    });
}

function planCreateError(error){
    if(error?.code==='23505')return 'That plan code already exists. Choose a different code.';
    if(error?.code==='23514'||error?.code==='22P02')return 'One of the plan values is outside the allowed range.';
    if(error?.message==='verification')return 'Verification failed.';
    if(error?.message&&[
        'Code must be','Enter a plan name.','Choose who can use this plan.','Choose a billing frequency.',
        'Currency must be','Enter a valid non-negative price','Price must be','Custom duration must be',
        'Regular reseller credit cost must be','Trial reseller credit cost must be'
    ].some(prefix=>error.message.startsWith(prefix)))return error.message;
    return 'Plan could not be created safely. Check the values and try again.';
}

async function customerCreate(req){
    const plans=await query(`SELECT code,name,price_minor,currency,audience FROM plans WHERE active=TRUE AND audience IN ('direct','both') ORDER BY sort_order,price_minor,name`);
    const opts=plans.rows.map(p=>`<option value="${esc(p.code)}">${esc(p.name)} · ${Number(p.price_minor)===0?'Free':esc(p.currency)+' '+(Number(p.price_minor)/100).toFixed(2)}</option>`).join('');
    return `${notice(req)}<section class="section"><form class="formPanel" method="post" action="/admin/users/new"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Username</label><input class="input" name="username" required pattern="[A-Za-z0-9._-]{3,40}" maxlength="40"></div><div class="formGroup"><label>Email</label><input class="input" name="email" type="email" required maxlength="254"></div><div class="formGroup"><label>Display name</label><input class="input" name="displayName" maxlength="100"></div><div class="formGroup"><label>Plan</label><select class="input" name="planCode">${opts}</select></div></div><div class="formGroup"><label>Verification code <span class="muted">(only when enabled)</span></label><input class="input" name="code"></div><button class="button">Create and provision</button></form></section>`;
}

function planCreateForm(req,values={},error=''){
    const submitted=Boolean(values.__submitted);
    const audience=['direct','reseller','both'].includes(values.audience)?values.audience:'direct';
    const billing=Object.prototype.hasOwnProperty.call(BILLING_TERMS,values.billingInterval)?values.billingInterval:'month';
    const standardDays=BILLING_TERMS[billing].days;
    const durationValue=values.durationDays||standardDays||30;
    const currency=text(values.currency||'USD',3).toUpperCase()||'USD';
    const price=values.price!==undefined&&values.price!==null&&String(values.price)!==''?String(values.price):'0.00';
    const resellerCredit=values.resellerCreditCost!==undefined?String(values.resellerCreditCost):'1';
    const resellerTrialCredit=values.resellerTrialCreditCost!==undefined?String(values.resellerTrialCreditCost):'1';
    const visible=submitted?b(values.visible):true;
    const active=submitted?b(values.active):true;
    const errorBlock=error?`<div class="notice error">${esc(error)}</div>`:'';
    const billingOptions=Object.entries(BILLING_TERMS).map(([key,item])=>`<option value="${key}" data-days="${item.days??''}" ${selected(key,billing)}>${esc(item.label)}</option>`).join('');
    return `${notice(req)}${errorBlock}<section class="section"><div class="sectionHead"><h2>New plan</h2><span class="muted">Define the commercial plan now; configure libraries, placement and payment-provider IDs after creation.</span></div><form class="formPanel" method="post" action="/admin/plans" data-plan-create-form>
        <input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="__submitted" value="1">
        <h3>Plan details</h3>
        <div class="formGrid">
            <div class="formGroup"><label>Code</label><input class="input" name="code" required pattern="[a-z0-9][a-z0-9-]{1,49}" maxlength="50" placeholder="premium-monthly" value="${esc(values.code||'')}"><div class="inlineHelp">Stable internal identifier. Lowercase letters, numbers and hyphens only.</div></div>
            <div class="formGroup"><label>Name</label><input class="input" name="name" required maxlength="80" placeholder="Monthly - 3 Streams" value="${esc(values.name||'')}"></div>
        </div>
        <div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500" placeholder="What this plan includes">${esc(values.description||'')}</textarea></div>

        <h3>Commercial terms</h3>
        <div class="formGrid">
            <div class="formGroup"><label>Audience</label><select class="input" name="audience" data-plan-audience><option value="direct" ${selected('direct',audience)}>Direct customers</option><option value="reseller" ${selected('reseller',audience)}>Resellers</option><option value="both" ${selected('both',audience)}>Direct + resellers</option></select></div>
            <div class="formGroup"><label>Price</label><input class="input" type="number" step="0.01" min="0" max="100000" name="price" required value="${esc(price)}"><div class="inlineHelp">Customer-facing cash price. Use 0 for a free plan/trial.</div></div>
            <div class="formGroup"><label>Currency</label><input class="input" name="currency" maxlength="3" minlength="3" required value="${esc(currency)}" placeholder="USD"><div class="inlineHelp">Three-letter code such as GBP, USD or EUR.</div></div>
        </div>
        <div class="formGrid">
            <div class="formGroup"><label>Billing / access frequency</label><select class="input" name="billingInterval" data-plan-frequency>${billingOptions}</select><div class="inlineHelp">Controls the normal plan period. Provider checkout mode/IDs are configured in Commerce afterwards.</div></div>
            <div class="formGroup"><label>Duration (days)</label><input class="input" type="number" name="durationDays" min="1" max="3650" required value="${esc(durationValue)}" data-plan-duration ${standardDays?'readonly':''}><div class="inlineHelp" data-duration-help>${standardDays?`${standardDays} days for ${BILLING_TERMS[billing].label}.`:'Used for manual/reseller extensions of this custom plan.'}</div></div>
            <div class="formGroup"><label>Server class</label><select class="input" name="serverClass"><option value="premium" ${selected('premium',values.serverClass||'premium')}>Premium</option><option value="free" ${selected('free',values.serverClass)}>Free</option><option value="custom" ${selected('custom',values.serverClass)}>Custom</option></select></div>
        </div>

        <div data-reseller-credit-fields ${audience==='direct'?'hidden':''}>
            <h3>Reseller credits</h3>
            <div class="securityNote standalone">These are <strong>wallet costs</strong>, not credits granted to the reseller. Reseller balances are managed under People → Resellers. One unit means one period of this plan.</div>
            <div class="formGrid">
                <div class="formGroup"><label>Regular credit cost / period</label><input class="input" type="number" min="0" max="100000" name="resellerCreditCost" value="${esc(resellerCredit)}"><div class="inlineHelp">Credits deducted when a reseller extends a client by one plan period. Leave blank to prevent regular-credit use.</div></div>
                <div class="formGroup"><label>Trial credit cost / period</label><input class="input" type="number" min="0" max="20" name="resellerTrialCreditCost" value="${esc(resellerTrialCredit)}"><div class="inlineHelp">Trial credits deducted when this plan is used to create/extend a trial client. Leave blank to hide it from trial-credit use.</div></div>
            </div>
        </div>

        <div class="toggleGrid">
            <label class="toggleRow"><input type="checkbox" name="visible" ${checked(visible)}><span>Visible in the applicable plan catalogue</span></label>
            <label class="toggleRow"><input type="checkbox" name="active" ${checked(active)}><span>Active</span></label>
        </div>
        <div class="formGroup"><label>Authenticator / recovery code <span class="muted">(not required again after normal signed-in admin authentication)</span></label><input class="input" name="code" autocomplete="one-time-code"></div>
        <div class="buttonRow"><button class="button" type="submit">Create plan</button><a class="button secondary" href="/admin/plans">Cancel</a></div>
    </form></section><script src="/js/admin-plan-create.js" defer></script>`;
}

async function createPlanPost(req,res){
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
        if(!(await auth.verifySecondFactor(req.session.authUserId,req.body.code,req)))throw new Error('verification');
        const input=planCreateInput(req.body);
        const created=await createPlanRecord(input,req.session.authUserId);
        return res.redirect(`/admin/plans/${encodeURIComponent(created.id)}/jellyfin?message=${encodeURIComponent('Plan created with pricing and reseller-credit terms. Configure Jellyfin policy, libraries and placement next.')}`);
    }catch(error){
        console.error('Plan create failed:',error.message);
        return send(res,{active:'plans',title:'New plan',subtitle:'Pricing, frequency and reseller-credit terms',body:planCreateForm(req,req.body,planCreateError(error)),action:'<a class="button secondary" href="/admin/plans">Back to Plans</a>'},400);
    }
}

function createAdminCatalogShellRouter(){
    const r=express.Router();
    r.use('/admin',gate,noStore);
    r.get('/admin/users/new',async(req,res,next)=>{try{return send(res,{active:'users',title:'Add customer',subtitle:'Create a Store account, subscription and Jellyfin entitlement',body:await customerCreate(req),action:'<a class="button secondary" href="/admin/users">Back</a>'})}catch(e){next(e)}});
    r.get('/admin/plans/new',(req,res)=>send(res,{active:'plans',title:'New plan',subtitle:'Pricing, frequency and reseller-credit terms',body:planCreateForm(req),action:'<a class="button secondary" href="/admin/plans">Back to Plans</a>'}));
    r.post('/admin/plans',createPlanPost);
    return r;
}

module.exports={createAdminCatalogShellRouter,planCreateInput,createPlanRecord,planCreateError,planCreateForm,BILLING_TERMS};
