'use strict';

require('dotenv').config();
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const bulkJobs=require('../src/platform/bulk-jobs');
const bulkWorker=require('../src/jellyfin/bulk-worker');
require('../src/platform/bulk-operations');

async function processJob(jobId){
    for(let i=0;i<10;i++){
        await bulkWorker.processBatch();
        const rows=await bulkJobs.listJobItems(jobId);
        if(rows.every(row=>['succeeded','failed'].includes(row.status)))return rows;
    }
    throw new Error('Bulk reseller assignment job did not settle.');
}

async function main(){
    const suffix=crypto.randomBytes(4).toString('hex');
    const tier=(await query(`INSERT INTO reseller_tiers(code,name,monthly_price_minor,currency,seat_limit,active,visible) VALUES($1,$2,1000,'USD',1,TRUE,TRUE) RETURNING id`,[`capacity-${suffix}`,`Capacity ${suffix}`])).rows[0];
    const user=(await query(`INSERT INTO app_users(username,password_hash,role) VALUES($1,'x','reseller') RETURNING id`,[`capacity-${suffix}`])).rows[0];
    const reseller=(await query('INSERT INTO resellers(user_id) VALUES($1) RETURNING id',[user.id])).rows[0];
    await query(`INSERT INTO reseller_subscriptions(reseller_id,tier_id,status,source,starts_at,current_period_end,seat_limit_snapshot,tier_name_snapshot,monthly_price_minor_snapshot,currency_snapshot) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days',1,$3,1000,'USD')`,[reseller.id,tier.id,`Capacity ${suffix}`]);
    const plan=(await query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible) VALUES($1,$2,'direct','custom',30,0,'USD',1,'premium',TRUE,TRUE) RETURNING id`,[`capacity-plan-${suffix}`,`Capacity plan ${suffix}`])).rows[0];

    const used=(await query(`INSERT INTO customers(reseller_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[reseller.id,`Used ${suffix}`,`used-${suffix}@example.invalid`])).rows[0];
    await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`,[used.id,plan.id]);

    const incoming=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Incoming ${suffix}`,`incoming-${suffix}@example.invalid`])).rows[0];
    await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`,[incoming.id,plan.id]);

    const blocked=await bulkJobs.createJob('reseller_assign',{resellerId:reseller.id});
    await bulkJobs.enqueueItems(blocked.job.id,[incoming.id]);
    const blockedRows=await processJob(blocked.job.id);
    if(blockedRows[0]?.status!=='failed'||!/no free seats/i.test(blockedRows[0]?.last_error||''))throw new Error('A full reseller must reject assignment of a live direct/manual customer.');
    const stillUnassigned=await query('SELECT reseller_id FROM customers WHERE id=$1',[incoming.id]);
    if(stillUnassigned.rows[0].reseller_id)throw new Error('Rejected reseller assignment still changed customer ownership.');

    await query('UPDATE reseller_tiers SET seat_limit=2 WHERE id=$1',[tier.id]);
    await query('UPDATE reseller_subscriptions SET seat_limit_snapshot=2 WHERE reseller_id=$1',[reseller.id]);
    const allowed=await bulkJobs.createJob('reseller_assign',{resellerId:reseller.id});
    await bulkJobs.enqueueItems(allowed.job.id,[incoming.id]);
    const allowedRows=await processJob(allowed.job.id);
    if(allowedRows[0]?.status!=='succeeded')throw new Error(`Assignment with free capacity should succeed: ${allowedRows[0]?.last_error||'unknown error'}`);
    const assigned=await query('SELECT reseller_id FROM customers WHERE id=$1',[incoming.id]);
    if(String(assigned.rows[0].reseller_id)!==String(reseller.id))throw new Error('Successful reseller assignment did not persist the reseller.');

    console.log('Bulk reseller capacity smoke test passed.');
}

main().finally(()=>getPool().end());
