'use strict';

const {query,transaction}=require('../db');
const verifier=require('./provider-mapping-verification');

function legacyState(fields){
    return ['verified','not_required'].includes(fields.verificationStatus)?'verified':'failed';
}
function snapshot(result){
    return {
        provider:result.provider||null,
        remote:result.remote||{},
        issues:Array.isArray(result.issues)?result.issues:[],
        notRequired:Boolean(result.notRequired)
    };
}
async function lockedCurrent(client,table,id,expected){
    const locked=await client.query(`SELECT provider,external_id${table==='plan_provider_prices'?',checkout_mode':''} FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);
    if(!locked.rowCount)throw new Error('Provider mapping no longer exists.');
    const row=locked.rows[0];
    if(row.provider!==expected.provider||String(row.external_id||'')!==String(expected.external_id||'')||(table==='plan_provider_prices'&&row.checkout_mode!==expected.checkout_mode)){
        throw new Error('Provider mapping changed while it was being verified. Reload and try again.');
    }
}
async function persist(table,id,expected,result){
    const fields=verifier.fields(result),state=legacyState(fields),snap=snapshot(result);
    return transaction(async client=>{
        await lockedCurrent(client,table,id,expected);
        await client.query(`UPDATE ${table} SET
            verified_at=$2,verification_status=$3,verification_error=$4,
            remote_amount_minor=$5,remote_currency=$6,remote_interval=$7,remote_active=$8,
            validation_state=$9,validated_at=$2,validation_error=$4,validated_external_snapshot=$10::jsonb,
            active=($9='verified'),updated_at=NOW()
            WHERE id=$1`,[
            id,fields.verifiedAt,fields.verificationStatus,fields.verificationError,
            fields.remoteAmountMinor,fields.remoteCurrency,fields.remoteInterval,fields.remoteActive,
            state,JSON.stringify(snap)
        ]);
        return fields;
    });
}
async function persistError(table,id,expected,error){
    const message=String(error?.message||error||'Provider verification failed').slice(0,2000),now=new Date();
    return transaction(async client=>{
        await lockedCurrent(client,table,id,expected);
        await client.query(`UPDATE ${table} SET
            verified_at=$2,verification_status='error',verification_error=$3,
            remote_amount_minor=NULL,remote_currency=NULL,remote_interval=NULL,remote_active=NULL,
            validation_state='failed',validated_at=$2,validation_error=$3,
            validated_external_snapshot=$4::jsonb,active=FALSE,updated_at=NOW()
            WHERE id=$1`,[id,now,message,JSON.stringify({error:message})]);
    });
}
async function validateDirect(id){
    const found=await query(`SELECT pp.*,p.price_minor,p.currency,p.billing_interval,p.name plan_name
        FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id WHERE pp.id=$1`,[id]);
    if(!found.rowCount)throw new Error('Direct plan provider mapping not found.');
    const row=found.rows[0];
    let result;
    try{
        result=await verifier.verify(row.provider,row.external_id,{
            priceMinor:row.price_minor,currency:row.currency,
            checkoutMode:row.checkout_mode==='payment'?'one_time':'subscription',
            billingInterval:row.billing_interval
        });
    }catch(error){await persistError('plan_provider_prices',id,row,error).catch(persistFailure=>console.error('Could not record provider mapping verification failure:',persistFailure.message));throw error;}
    await persist('plan_provider_prices',id,row,result);
    if(result.issues?.length)throw new Error(`Provider mapping does not match ${row.plan_name||'this plan'}: ${result.issues.join('; ')}`);
    return{row,result};
}
async function validateReseller(id){
    const found=await query(`SELECT rp.*,rt.monthly_price_minor price_minor,rt.currency,rt.name tier_name
        FROM reseller_tier_provider_prices rp JOIN reseller_tiers rt ON rt.id=rp.tier_id WHERE rp.id=$1`,[id]);
    if(!found.rowCount)throw new Error('Reseller tier provider mapping not found.');
    const row=found.rows[0];
    let result;
    try{
        result=await verifier.verify(row.provider,row.external_id,{
            priceMinor:row.price_minor,currency:row.currency,checkoutMode:'subscription',billingInterval:'month'
        });
    }catch(error){await persistError('reseller_tier_provider_prices',id,row,error).catch(persistFailure=>console.error('Could not record reseller mapping verification failure:',persistFailure.message));throw error;}
    await persist('reseller_tier_provider_prices',id,row,result);
    if(result.issues?.length)throw new Error(`Provider mapping does not match ${row.tier_name||'this reseller tier'}: ${result.issues.join('; ')}`);
    return{row,result};
}

module.exports={validateDirect,validateReseller,persist,persistError};
