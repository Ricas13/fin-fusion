'use strict';

require('dotenv').config();
process.env.PUBLIC_REGISTRATION = 'true';
process.env.REQUIRE_EMAIL_VERIFICATION = 'false';

const customers = require('../src/customers');
const lifecycle = require('../src/payments/lifecycle');
const { getPool, query } = require('../src/db');

async function main() {
    const suffix = Date.now().toString(36);
    const password = `Smoke-Test-${suffix}-Password`;
    const registered = await customers.registerCustomer({
        email: `smoke-${suffix}@example.invalid`,
        username: `smoke_${suffix}`,
        password
    });
    if (!registered.customer?.id) throw new Error('Customer registration failed');

    const login = await customers.authenticateCustomer(`smoke-${suffix}@example.invalid`, password);
    if (!login || login.customerId !== registered.customer.id) throw new Error('Customer authentication failed');

    const plans = await customers.listPublicPlans();
    if (plans.length < 4) throw new Error('Seeded plans are missing');

    const seededCredits = await query(`
        SELECT code,reseller_credit_cost,reseller_trial_credit_cost
        FROM plans WHERE code IN ('trial-24h','monthly') ORDER BY code
    `);
    const monthly = seededCredits.rows.find(row => row.code === 'monthly');
    const trial = seededCredits.rows.find(row => row.code === 'trial-24h');
    if (Number(monthly?.reseller_credit_cost) !== 1) throw new Error('Seeded monthly reseller credit cost is missing');
    if (Number(trial?.reseller_trial_credit_cost) !== 1) throw new Error('Seeded trial credit cost is missing');

    const resellerCode = `smoke-reseller-${suffix}`;
    await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,reseller_credit_cost,reseller_trial_credit_cost)
        VALUES($1,'Smoke reseller plan','reseller','custom',45,0,'USD',2,'premium',TRUE,TRUE,3,2)
    `, [resellerCode]);
    const publicAfterReseller = await customers.listPublicPlans();
    if (publicAfterReseller.some(plan => plan.code === resellerCode)) throw new Error('Reseller-only plan leaked into public Store plans');

    const portal = await customers.getCustomerPortal(registered.customer.id);
    if (!portal || portal.customer.id !== registered.customer.id) throw new Error('Customer portal query failed');

    if (lifecycle.mapProviderStatus('stripe', 'active') !== 'active') throw new Error('Stripe state mapping failed');
    if (lifecycle.mapProviderStatus('paypal', 'SUSPENDED') !== 'paused') throw new Error('PayPal state mapping failed');

    console.log(`Platform smoke test passed for ${login.username}; ${plans.length} public plans available.`);
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
