'use strict';

require('dotenv').config();
const crypto=require('crypto');
const {query,transaction,getPool}=require('../src/db');
const managedUsers=require('../src/resellers/managed-users');

async function main(){
    const suffix=crypto.randomBytes(4).toString('hex');
    const tier=(await query(`INSERT INTO reseller_tiers(code,name,monthly_price_minor,currency,seat_limit,active,visible) VALUES($1,$2,1000,'USD',1,TRUE,TRUE) RETURNING id`,[`capacity-${suffix}`,`Capacity ${suffix}`])).rows[0];
    const user=(await query(`INSERT INTO app_users(username,password_hash,role) VALUES($1,'x','reseller') RETURNING id`,[`capacity-${suffix}`])).rows[0];
    const reseller=(await query('INSERT INTO resellers(user_id) VALUES($1) RETURNING id',[user.id])).rows[0];
    await query(`INSERT INTO reseller_subscriptions(reseller_id,tier_id,status,source,starts_at,current_period_end,seat_limit_snapshot,tier_name_snapshot,monthly_price_minor_snapshot,currency_snapshot) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days',1,$3,1000,'USD')`,[reseller.id,tier.id,`Capacity ${suffix}`]);

    await query(`INSERT INTO customers(reseller_id,display_name,reseller_managed,note) VALUES($1,$2,TRUE,'capacity smoke')`,[reseller.id,`managed-${suffix}`]);
    if(await managedUsers.seatUsage(reseller.id)!==1)throw new Error('Managed Jellyfin user must occupy one reseller seat.');

    let blocked=false;
    try{await transaction(client=>managedUsers.assertSeatAvailable(client,reseller.id));}catch(error){blocked=/full|managed jellyfin users/i.test(error.message||'');}
    if(!blocked)throw new Error('A full reseller must reject another managed Jellyfin user seat.');

    // Direct/manual CAPTAiNFiN customers are no longer the reseller seat model.
    const direct=(await query(`INSERT INTO customers(display_name,email,reseller_managed) VALUES($1,$2,FALSE) RETURNING id`,[`Direct ${suffix}`,`direct-${suffix}@example.invalid`])).rows[0];
    await query('UPDATE customers SET reseller_id=$2 WHERE id=$1',[direct.id,reseller.id]);
    if(await managedUsers.seatUsage(reseller.id)!==1)throw new Error('Ordinary customer ownership must not consume a managed reseller seat.');

    await query('UPDATE reseller_tiers SET seat_limit=2 WHERE id=$1',[tier.id]);
    await query('UPDATE reseller_subscriptions SET seat_limit_snapshot=2 WHERE reseller_id=$1',[reseller.id]);
    const capacity=await transaction(client=>managedUsers.assertSeatAvailable(client,reseller.id));
    if(Number(capacity.used)!==1||Number(capacity.limit)!==2)throw new Error('Expanded reseller plan did not expose the expected managed-user seat.');

    console.log('Managed reseller capacity smoke test passed.');
}

main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>getPool().end());
