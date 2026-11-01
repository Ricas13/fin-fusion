'use strict';

require('dotenv').config();
// Plisio recovery only runs while Plisio is configured; give the smoke a throwaway key.
process.env.PLISIO_SECRET_KEY = process.env.PLISIO_SECRET_KEY || 'plisio-recovery-smoke-key';
process.env.PLISIO_ENABLED = 'true';
const assert = require('assert');
const { query } = require('../src/db');
const { runDbSmoke, unique: fixtureUnique, fixtureCustomer, fixturePlan } = require('./test-fixture');
const intents = require('../src/payments/checkout-intents');
const recovery = require('../src/payments/provider-checkout-recovery');
const plisio = require('../src/payments/plisio');

const suffix = fixtureUnique('checkout-recovery');
const createdCustomers = [];
const createdPlans = [];
const createdIntents = [];
const createdServers = [];

function unique(label) { return `${label}-${suffix}-${fixtureUnique('case')}`; }

async function ensurePremiumCapacity() {
    const row = (await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,base_url,public_url,location,api_key_encrypted,
            enabled,allow_new_users,paid_enabled,priority,max_users,
            health_status,last_health_check
        )
        VALUES($1,$2,'premium','https://checkout-recovery.example.invalid',
               'https://checkout-recovery.example.invalid','Checkout Recovery','key',
               TRUE,TRUE,TRUE,10,1000,'healthy',NOW())
        RETURNING id,location
    `, [`Checkout recovery ${suffix}`, unique('checkout-recovery-server')])).rows[0];
    createdServers.push(row.id);
    return row;
}

async function customer(label) {
    const row = await fixtureCustomer({ query }, {
        displayName: label,
        email: `${unique(label)}@example.invalid`
    });
    createdCustomers.push(row.id);
    return row;
}

async function plan(label, server) {
    const row = await fixturePlan({ query }, {
        code: unique(label),
        name: label,
        serviceType: 'jellyfin',
        audience: 'direct',
        billingInterval: 'month',
        durationDays: 30,
        priceMinor: 1000,
        currency: 'GBP',
        capacityLimit: 100,
        streams: 1,
        serverClass: 'premium'
    });
    createdPlans.push(row.id);
    await query(
        'INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)',
        [row.id, server.id]
    );
    return { ...row, test_media_location: server.location };
}

function snapshotFor(p, provider, providerMappingId, checkoutMode = 'subscription') {
    return {
        kind: 'direct_plan',
        planId: p.id,
        planPriceId: null,
        planCode: p.code,
        planName: p.name,
        priceMinor: Number(p.price_minor),
        discountedMinor: Number(p.price_minor),
        currency: 'GBP',
        billingInterval: 'month',
        durationDays: 30,
        streams: 1,
        stremioHouseholdNetworkLimit: 1,
        provider,
        checkoutMode,
        providerMappingId,
        providerMappingRecordId: null,
        mediaLocation: p.test_media_location
    };
}

async function attachedIntent(label, provider, providerCheckoutId, providerMappingId, checkoutMode = 'subscription', server) {
    const owner = await customer(`${label} customer`);
    const p = await plan(`${label} plan`, server);
    const created = await intents.createIntent({
        scope: 'customer',
        customerId: owner.id,
        planId: p.id,
        provider,
        checkoutMode,
        commercialSnapshot: snapshotFor(p, provider, providerMappingId, checkoutMode)
    });
    await intents.attachProviderCheckout(created.id, providerCheckoutId);
    createdIntents.push(created.id);
    return { ...created, owner, plan: p, providerCheckoutId };
}

async function stateOf(id) {
    return (await query(`SELECT state,provider_terminal_at FROM billing_checkout_intents WHERE id=$1`, [id])).rows[0];
}

async function cleanup() {
    if (createdIntents.length) await query(`DELETE FROM billing_checkout_intents WHERE id=ANY($1::uuid[])`, [createdIntents]).catch(() => {});
    if (createdPlans.length) await query(`DELETE FROM plans WHERE id=ANY($1::uuid[])`, [createdPlans]).catch(() => {});
    if (createdCustomers.length) await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [createdCustomers]).catch(() => {});
    if (createdServers.length) await query(`DELETE FROM jellyfin_servers WHERE id=ANY($1::uuid[])`, [createdServers]).catch(() => {});
}

function missingPayPalError(status = 404, message = 'The specified resource does not exist.') {
    const error = new Error(message);
    error.provider = 'paypal';
    error.code = 'http_error';
    error.status = status;
    error.retryable = false;
    return error;
}

async function main() {
    const server = await ensurePremiumCapacity();
    const stripeOk = await attachedIntent('recovery stripe ok', 'stripe', `cs_test_${unique('ok')}`, `price_${unique('ok')}`, 'subscription', server);
    const stripeFail = await attachedIntent('recovery stripe fail', 'stripe', `cs_test_${unique('fail')}`, `price_${unique('fail')}`, 'subscription', server);
    const stripePayment = await attachedIntent('recovery stripe payment', 'stripe', `cs_test_${unique('payment')}`, null, 'payment', server);
    const paypalActive = await attachedIntent('recovery paypal active', 'paypal', `I-${unique('active')}`, `P-${unique('active')}`, 'subscription', server);
    const paypalPending = await attachedIntent('recovery paypal pending', 'paypal', `I-${unique('pending')}`, `P-${unique('pending')}`, 'subscription', server);

    const first = await recovery.run({
        limit: 20,
        checkoutIntentIds: createdIntents,
        handlers: {
            async stripe(row) {
                if (row.id === stripeFail.id) throw new Error('synthetic provider timeout');
                await intents.completeVerifiedProvider('stripe', row.provider_checkout_id, 'completed');
                return { completed: true, waiting: false, status: 'completed' };
            },
            async paypalStatus(row) {
                if (row.id === paypalPending.id) return { row: null, providerStatus: 'APPROVAL_PENDING' };
                return { row: null, providerStatus: 'ACTIVE' };
            },
            async paypalActivate(row) {
                await intents.completeVerifiedProvider('paypal', row.provider_checkout_id, 'completed');
                return { id: `subscription-${row.id}` };
            },
            async markTerminal(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
            },
            async markCompleted(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'completed');
            }
        }
    });

    assert.strictEqual(first.total, 5, 'first recovery pass must see unfinished recurring checkouts plus Stripe one-time checkouts');
    assert.strictEqual(first.processed, 5, 'one provider failure must not abort the rest of the batch');
    assert.strictEqual(first.recovered, 3, 'Stripe subscription/payment and PayPal ACTIVE checkouts must recover');
    assert.strictEqual(first.waiting, 1, 'PayPal approval-pending checkout must remain waiting');
    assert.strictEqual(first.failed, 1, 'provider failure must remain retryable and operator-visible');
    assert.strictEqual((await stateOf(stripeOk.id)).state, 'completed');
    assert.strictEqual((await stateOf(stripePayment.id)).state, 'completed', 'paid Stripe one-time Checkout must enter the same verified recovery path');
    assert.strictEqual((await stateOf(paypalActive.id)).state, 'completed');
    assert.strictEqual((await stateOf(stripeFail.id)).state, 'open');
    assert.strictEqual((await stateOf(paypalPending.id)).state, 'open', 'approval-pending PayPal must never be converted into access');

    const second = await recovery.run({
        limit: 20,
        checkoutIntentIds: createdIntents,
        handlers: {
            async stripe(row) {
                await intents.completeVerifiedProvider('stripe', row.provider_checkout_id, 'completed');
                return { completed: true, waiting: false, status: 'completed' };
            },
            async paypalStatus() {
                return { row: null, providerStatus: 'EXPIRED' };
            },
            async paypalActivate() {
                throw new Error('terminal PayPal checkout must not activate');
            },
            async markTerminal(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
            },
            async markCompleted(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'completed');
            }
        }
    });

    assert.strictEqual(second.total, 2, 'completed recoveries must disappear from the retry set');
    assert.strictEqual(second.recovered, 1, 'failed Stripe checkout must be retryable on the next pass');
    assert.strictEqual(second.terminal, 1, 'provider-terminal PayPal checkout must close without access');
    assert.strictEqual(second.failed, 0);
    assert.strictEqual((await stateOf(stripeFail.id)).state, 'completed');
    const pendingTerminal = await stateOf(paypalPending.id);
    assert.strictEqual(pendingTerminal.state, 'cancelled');
    assert(pendingTerminal.provider_terminal_at, 'verified provider-terminal checkout must record terminal proof');

    const third = await recovery.run({ limit: 20, checkoutIntentIds: createdIntents, handlers: {} });
    assert.strictEqual(third.total, 0, 'settled/terminal checkouts must not be polled forever');

    const paypalMissing = await attachedIntent(
        'recovery paypal missing',
        'paypal',
        `I-${unique('missing')}`,
        `P-${unique('missing')}`,
        'subscription',
        server
    );
    await query(`
        UPDATE billing_checkout_intents
        SET state='expired',expires_at=NOW()-INTERVAL '1 minute',updated_at=NOW()
        WHERE id=$1
    `, [paypalMissing.id]);

    const missingResult = await recovery.run({
        limit: 20,
        checkoutIntentIds: [paypalMissing.id],
        handlers: {
            async paypalStatus() {
                throw missingPayPalError();
            },
            async markTerminal(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
            }
        }
    });
    assert.strictEqual(missingResult.total, 1);
    assert.strictEqual(missingResult.terminal, 1, 'expired PayPal checkout missing at the provider must converge terminally');
    assert.strictEqual(missingResult.failed, 0);
    const missingTerminal = await stateOf(paypalMissing.id);
    assert.strictEqual(missingTerminal.state, 'expired', 'provider proof must not rewrite the historical local expiry state');
    assert(missingTerminal.provider_terminal_at, 'provider-not-found must record terminal proof');
    assert.strictEqual((await recovery.candidates({ checkoutIntentIds: [paypalMissing.id] })).length, 0,
        'provider-terminal expired PayPal checkout must leave the retry set');

    const paypalOpenMissing = await attachedIntent(
        'recovery paypal open missing',
        'paypal',
        `I-${unique('open-missing')}`,
        `P-${unique('open-missing')}`,
        'subscription',
        server
    );
    const openMissingResult = await recovery.run({
        limit: 20,
        checkoutIntentIds: [paypalOpenMissing.id],
        handlers: {
            async paypalStatus() {
                throw missingPayPalError();
            }
        }
    });
    assert.strictEqual(openMissingResult.failed, 1, 'open PayPal 404 must remain operator-visible');
    assert.strictEqual((await stateOf(paypalOpenMissing.id)).state, 'open');

    assert.strictEqual(recovery.paypalResourceNotFound(missingPayPalError(404)), true);
    assert.strictEqual(recovery.paypalResourceNotFound(missingPayPalError(422)), true);
    assert.strictEqual(recovery.paypalResourceNotFound(missingPayPalError(422, 'Validation failed.')), false,
        'generic PayPal 422 must not be mistaken for resource absence');

    // Plisio crypto checkouts: a lost or rejected callback must not strand a paid customer.
    const plisioRecovered = await attachedIntent('recovery plisio paid', 'plisio', `PLISIO-${unique('paid')}`, null, 'payment', server);
    const plisioUnverifiable = await attachedIntent('recovery plisio unverifiable', 'plisio', `PLISIO-${unique('unverifiable')}`, null, 'payment', server);
    const plisioWaiting = await attachedIntent('recovery plisio waiting', 'plisio', `PLISIO-${unique('waiting')}`, null, 'payment', server);
    const plisioTerminal = await attachedIntent('recovery plisio terminal', 'plisio', `PLISIO-${unique('terminal')}`, null, 'payment', server);
    const plisioIds = [plisioRecovered.id, plisioUnverifiable.id, plisioWaiting.id, plisioTerminal.id];
    const candidateIds = new Set((await recovery.candidates({ limit: 100 })).map(row => row.id));
    for (const id of plisioIds) assert(candidateIds.has(id), 'open Plisio checkouts must be recovery candidates');

    const plisioRun = await recovery.run({
        limit: 20,
        checkoutIntentIds: plisioIds,
        handlers: {
            async plisio(row) {
                if (row.id === plisioRecovered.id) return { status: 'completed', completed: true };
                if (row.id === plisioUnverifiable.id) return { status: 'completed', completed: false, waiting: true };
                if (row.id === plisioWaiting.id) return { status: 'pending', completed: false, waiting: true };
                return { status: 'expired', completed: false, terminal: true };
            }
        }
    });
    assert.strictEqual(plisioRun.recovered, 1, 'a verified completed Plisio payment must be recovered');
    assert.strictEqual(plisioRun.waiting, 1, 'a pending Plisio payment must keep waiting');
    assert.strictEqual(plisioRun.terminal, 1, 'an expired Plisio invoice must settle as terminal');
    assert.strictEqual(plisioRun.failed, 1, 'a completed but unverifiable Plisio payment must be operator-visible, not silently waiting');
    assert(/Plisio .*fiat amount could not be verified/.test(plisioRun.warning), 'unverifiable Plisio payment must raise a job warning');

    // Candidate boundaries: finished, provider-terminal and stale checkouts are not polled.
    await query(`UPDATE billing_checkout_intents SET state='completed' WHERE id=$1`, [plisioRecovered.id]);
    await query(`UPDATE billing_checkout_intents SET state='expired',provider_terminal_at=NOW() WHERE id=$1`, [plisioTerminal.id]);
    await query(`UPDATE billing_checkout_intents SET state='failed',provider_terminal_at=NOW() WHERE id=$1`, [plisioUnverifiable.id]);
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '10 days' WHERE id=$1`, [plisioWaiting.id]);
    const afterIds = new Set((await recovery.candidates({ limit: 100 })).map(row => row.id));
    assert(!afterIds.has(plisioRecovered.id), 'completed Plisio checkouts must not be polled');
    assert(!afterIds.has(plisioTerminal.id), 'provider-terminal expired Plisio checkouts must not be polled');
    assert(afterIds.has(plisioUnverifiable.id), 'recently failed (e.g. underpaid) Plisio checkouts stay eligible for a top-up');
    assert(!afterIds.has(plisioWaiting.id), 'an aged unresolved Plisio checkout that was just checked is not polled again straight away');

    // Beyond the fast 7-day window an unresolved invoice is still checked, once a day, up to 90 days.
    await query(`UPDATE billing_checkout_intents SET updated_at=NOW()-INTERVAL '2 days' WHERE id=$1`, [plisioWaiting.id]);
    assert((new Set((await recovery.candidates({ limit: 100 })).map(row => row.id))).has(plisioWaiting.id), 'a 10-day-old unresolved Plisio checkout is checked again once a day');
    const agedRun = await recovery.run({ limit: 100, checkoutIntentIds: [plisioWaiting.id], handlers: { async plisio() { return { status: 'pending', completed: false, waiting: true }; } } });
    assert.strictEqual(agedRun.waiting, 1);
    assert(!(new Set((await recovery.candidates({ limit: 100 })).map(row => row.id))).has(plisioWaiting.id), 'and after being checked it waits until tomorrow');
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '100 days',updated_at=NOW()-INTERVAL '2 days' WHERE id=$1`, [plisioWaiting.id]);
    assert(!(new Set((await recovery.candidates({ limit: 100 })).map(row => row.id))).has(plisioWaiting.id), 'automatic checking stops after 90 days');
    assert.strictEqual((await recovery.candidates({ limit: 100, checkoutIntentIds: [plisioWaiting.id] })).length, 0, 'a scoped request without the override still respects the windows');
    assert.strictEqual((await recovery.candidates({ limit: 100, checkoutIntentIds: [plisioWaiting.id], ignoreLookback: true })).length, 1, 'an operator re-check of one named checkout ignores every age window');
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '10 days' WHERE id=$1`, [plisioWaiting.id]);
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '3 days' WHERE id=$1`, [plisioUnverifiable.id]);
    assert(!(new Set((await recovery.candidates({ limit: 100 })).map(row => row.id))).has(plisioUnverifiable.id),
        'failed Plisio checkouts stop being re-polled after 48 hours');

    // Production reality: Plisio's operations API returns only ids, status and crypto totals for an
    // invoice (no order number, fiat amount or currency). A completed invoice bound to our intent
    // must activate from the contract we created the invoice with, but nothing looser.
    // --- Automatic closure (no operator): an invoice nobody ever paid, and one Plisio no longer knows about.
    const giveUp = await attachedIntent('recovery plisio never paid', 'plisio', `PLISIO-${unique('never')}`, null, 'payment', server);
    const inFlight = await attachedIntent('recovery plisio in flight', 'plisio', `PLISIO-${unique('flight')}`, null, 'payment', server);
    const fresh = await attachedIntent('recovery plisio fresh', 'plisio', `PLISIO-${unique('fresh')}`, null, 'payment', server);
    const gone = await attachedIntent('recovery plisio not found', 'plisio', `PLISIO-${unique('gone')}`, null, 'payment', server);
    const goneEarly = await attachedIntent('recovery plisio not found early', 'plisio', `PLISIO-${unique('goneearly')}`, null, 'payment', server);
    const outage = await attachedIntent('recovery plisio outage', 'plisio', `PLISIO-${unique('outage')}`, null, 'payment', server);
    const reviewOld = await attachedIntent('recovery plisio review old', 'plisio', `PLISIO-${unique('reviewold')}`, null, 'payment', server);
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '2 days',updated_at=NOW()-INTERVAL '2 days' WHERE id=ANY($1::uuid[])`, [[giveUp.id, inFlight.id, gone.id, outage.id, reviewOld.id]]);
    await query(`UPDATE billing_checkout_intents SET operator_resolution='marked_paid_review',operator_resolved_at=NOW() WHERE id=$1`, [reviewOld.id]);
    const notFound = Object.assign(new Error('unavailable'), { providerNotFound: true, providerStatus: 404 });
    const unavailable = Object.assign(new Error('unavailable'), { providerNotFound: false, providerStatus: 503 });
    const autoRun = await recovery.run({
        limit: 100,
        checkoutIntentIds: [giveUp.id, inFlight.id, fresh.id, gone.id, goneEarly.id, outage.id, reviewOld.id],
        handlers: {
            async plisio(row) {
                if (row.id === giveUp.id || row.id === fresh.id || row.id === reviewOld.id) return { status: 'new', completed: false, waiting: true };
                if (row.id === inFlight.id) return { status: 'pending', completed: false, waiting: true };
                if (row.id === gone.id || row.id === goneEarly.id) throw notFound;
                throw unavailable;
            },
            async autoClose(row, note) { return intents.autoCloseUnpaid(row.id, note); },
            async markTerminal(row) { return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled'); }
        }
    });
    const giveUpRow = (await query(`SELECT state,provider_terminal_at,operator_resolution,operator_resolved_by FROM billing_checkout_intents WHERE id=$1`, [giveUp.id])).rows[0];
    assert.strictEqual(giveUpRow.operator_resolution, 'dismissed', 'an invoice still unpaid long after its window is closed automatically (it leaves the Orders queue)');
    assert.strictEqual(giveUpRow.operator_resolved_by, null, 'recorded as automatic, with no operator');
    assert.strictEqual(giveUpRow.provider_terminal_at, null, 'but NOT provider-terminal: it keeps being re-checked so a late payment is still found');
    assert((new Set((await recovery.candidates({ limit: 100 })).map(row => row.id))).has(giveUp.id), 'and the worker still polls it');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM audit_log WHERE action='billing.checkout.auto_closed' AND entity_id=$1`, [giveUp.id])).rows[0].n, 1, 'the automatic closure is audited');
    assert.strictEqual((await query(`SELECT operator_resolution FROM billing_checkout_intents WHERE id=$1`, [reviewOld.id])).rows[0].operator_resolution, 'marked_paid_review', 'a payment an operator tried to record is never auto-closed as unpaid');
    assert.strictEqual((await stateOf(gone.id)).state, 'cancelled', 'an old invoice Plisio reports as not found (404) is closed automatically');
    assert.strictEqual((await stateOf(inFlight.id)).state, 'open', 'a payment that is pending on the chain is never given up on by age');
    assert.strictEqual((await stateOf(fresh.id)).state, 'open', 'an invoice inside its window is left alone');
    assert.strictEqual((await stateOf(goneEarly.id)).state, 'open', 'not-found inside the window is not trusted yet');
    assert.strictEqual((await stateOf(outage.id)).state, 'open', 'a Plisio outage (503) is never mistaken for an abandoned invoice');
    assert.strictEqual(autoRun.terminal, 2, 'exactly the abandoned invoice and the not-found one were closed');
    assert.strictEqual(autoRun.failed, 2, 'early not-found and the outage stay visible as recovery failures');
    // A closed invoice that is paid late still activates (only completed payments may override a closed intent).
    const closedRow = (await query(`SELECT commercial_snapshot FROM billing_checkout_intents WHERE id=$1`, [giveUp.id])).rows[0];
    const closedSnapshot = closedRow.commercial_snapshot;
    assert.strictEqual((await intents.verifiedProviderContract({
        provider: 'plisio', providerCheckoutId: giveUp.providerCheckoutId, scope: 'customer', ownerId: giveUp.owner.id,
        planId: giveUp.plan.id, checkoutMode: 'payment', amountMinor: Number(closedSnapshot.discountedMinor ?? closedSnapshot.priceMinor), currency: closedSnapshot.currency
    })).intent.id, giveUp.id, 'a late payment on an auto-closed invoice is still accepted by the checkout contract');

    // --- Fairness: payments inside their window first, then least-recently-checked, so a backlog is worked through in turn.
    const old1 = await attachedIntent('recovery fair 1', 'plisio', `PLISIO-${unique('fair1')}`, null, 'payment', server);
    const old2 = await attachedIntent('recovery fair 2', 'plisio', `PLISIO-${unique('fair2')}`, null, 'payment', server);
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '3 days',updated_at=NOW()-INTERVAL '3 hours' WHERE id=$1`, [old1.id]);
    await query(`UPDATE billing_checkout_intents SET created_at=NOW()-INTERVAL '3 days',updated_at=NOW()-INTERVAL '5 hours' WHERE id=$1`, [old2.id]);
    const order = (await recovery.candidates({ limit: 100, checkoutIntentIds: [old1.id, old2.id, fresh.id] })).map(row => row.id);
    assert.deepStrictEqual(order, [fresh.id, old2.id, old1.id], 'in-window payment first, then the longest-unchecked backlog row');
    const fresh2 = await attachedIntent('recovery fair fresh 2', 'plisio', `PLISIO-${unique('fair3')}`, null, 'payment', server);
    const fresh3 = await attachedIntent('recovery fair fresh 3', 'plisio', `PLISIO-${unique('fair4')}`, null, 'payment', server);
    const squeezed = (await recovery.candidates({ limit: 2, checkoutIntentIds: [fresh.id, fresh2.id, fresh3.id, old2.id] })).map(row => row.id);
    assert(squeezed.includes(old2.id), 'with more in-window payments than slots, an older row still gets a slot every batch (no starvation)');
    assert.strictEqual(squeezed.filter(id => id !== old2.id).length, 1, 'and the rest of the batch still goes to payments inside their window');
    await recovery.run({ limit: 100, checkoutIntentIds: [old2.id], handlers: { async plisio() { return { status: 'pending', completed: false, waiting: true }; } } });
    assert.deepStrictEqual((await recovery.candidates({ limit: 100, checkoutIntentIds: [old1.id, old2.id] })).map(row => row.id), [old1.id, old2.id], 'a row that was just checked goes to the back of the line');

    // --- A payment the operator marked for review is still recovered automatically (it no longer needs finishing by hand).
    const review = await attachedIntent('recovery plisio review', 'plisio', `PLISIO-${unique('review')}`, null, 'payment', server);
    await query(`UPDATE billing_checkout_intents SET operator_resolution='marked_paid_review',operator_resolved_at=NOW() WHERE id=$1`, [review.id]);
    assert((new Set((await recovery.candidates({ limit: 100 })).map(row => row.id))).has(review.id), 'marked_paid_review rows are no longer excluded from automatic recovery');

    const realShape = txn => ({ txn_id: txn, invoice_url: `https://plisio.net/invoice/${txn}`, invoice_total_sum: '0.00060658', user_id: 12174, shop_id: 's1', type: 'invoice', status: 'completed', tx_url: 'https://blockchair.com/bitcoin/transaction/abc', id: txn });
    const contractIntent = {
        id: 'intent-1', provider: 'plisio', checkout_mode: 'payment', provider_checkout_id: 'TXN-1',
        commercial_snapshot: { discountedMinor: 5000, priceMinor: 5000, currency: 'usd' }
    };
    assert.deepStrictEqual(plisio.contractFieldsFromIntent(contractIntent, 'TXN-1'), { orderNumber: 'intent-1', sourceAmount: '50.00', sourceCurrency: 'USD' });
    assert.strictEqual(plisio.contractFieldsFromIntent(contractIntent, 'TXN-OTHER'), null, 'a different transaction id must not use this intent contract');
    assert.strictEqual(plisio.contractFieldsFromIntent({ ...contractIntent, checkout_mode: 'subscription' }, 'TXN-1'), null);
    assert.strictEqual(plisio.contractFieldsFromIntent({ ...contractIntent, provider: 'stripe' }, 'TXN-1'), null);
    assert.strictEqual(plisio.contractFieldsFromIntent({ ...contractIntent, commercial_snapshot: { currency: 'USD' } }, 'TXN-1'), null);
    assert.strictEqual(plisio.contractFieldsFromIntent({ ...contractIntent, commercial_snapshot: { priceMinor: 5000 } }, 'TXN-1'), null);

    const realFetch = global.fetch;
    const remote = new Map();
    global.fetch = async (url, options) => {
        const u = new URL(String(url));
        if (u.hostname !== 'api.plisio.net') return realFetch(url, options);
        const id = decodeURIComponent(u.pathname.split('/').pop());
        const entry = remote.get(id);
        if (entry && entry.__http) return new Response(entry.body, { status: entry.__http });
        return new Response(JSON.stringify({ status: 'success', data: entry }), { status: 200 });
    };
    try {
        const paid = await attachedIntent('recovery plisio real shape', 'plisio', `PLISIO-${unique('realshape')}`, null, 'payment', server);
        remote.set(paid.providerCheckoutId, realShape(paid.providerCheckoutId));
        const paidRow = await intents.findById(paid.id);
        const confirmed = await plisio.confirmCheckout(paid.providerCheckoutId, paidRow);
        assert.strictEqual(confirmed.completed, true, 'a completed Plisio invoice with no fiat fields must activate from its own contract');
        assert.strictEqual((await stateOf(paid.id)).state, 'completed');

        const underpaid = await attachedIntent('recovery plisio mismatch', 'plisio', `PLISIO-${unique('mismatchreal')}`, null, 'payment', server);
        remote.set(underpaid.providerCheckoutId, { ...realShape(underpaid.providerCheckoutId), status: 'mismatch' });
        const mismatchOutcome = await plisio.confirmCheckout(underpaid.providerCheckoutId, await intents.findById(underpaid.id));
        assert.strictEqual(mismatchOutcome.completed, false, 'a mismatch (wrong amount paid) must never activate');

        const pending = await attachedIntent('recovery plisio pending real', 'plisio', `PLISIO-${unique('pendingreal')}`, null, 'payment', server);
        remote.set(pending.providerCheckoutId, { ...realShape(pending.providerCheckoutId), status: 'pending' });
        const pendingOutcome = await plisio.confirmCheckout(pending.providerCheckoutId, await intents.findById(pending.id));
        assert.strictEqual(pendingOutcome.completed, false);
        assert.strictEqual(pendingOutcome.waiting, true);

        // Old invoices clear themselves: a 40-day-old unresolved invoice that Plisio reports as expired is closed by
        // the ordinary worker (no operator involved), and one that Plisio reports as paid is activated.
        const agedExpired = await attachedIntent('recovery plisio aged expired', 'plisio', `PLISIO-${unique('agedexpired')}`, null, 'payment', server);
        const agedPaid = await attachedIntent('recovery plisio aged paid', 'plisio', `PLISIO-${unique('agedpaid')}`, null, 'payment', server);
        remote.set(agedExpired.providerCheckoutId, { ...realShape(agedExpired.providerCheckoutId), status: 'expired' });
        remote.set(agedPaid.providerCheckoutId, realShape(agedPaid.providerCheckoutId));
        await query(`UPDATE billing_checkout_intents SET state='open',created_at=NOW()-INTERVAL '40 days',updated_at=NOW()-INTERVAL '3 days' WHERE id=ANY($1::uuid[])`, [[agedExpired.id, agedPaid.id]]);
        const agedRunAll = await recovery.run({ limit: 100 });
        assert(agedRunAll.terminal >= 1 && agedRunAll.recovered >= 1, 'the daily check of old invoices closes an expired one and activates a paid one automatically');
        const agedExpiredRow = await stateOf(agedExpired.id), agedPaidRow = await stateOf(agedPaid.id);
        assert(agedExpiredRow.provider_terminal_at, 'the expired invoice is marked closed by the provider, so it leaves the exception queue');
        assert.strictEqual(agedPaidRow.state, 'completed', 'the paid old invoice is completed and access is activated');

        // Only Plisio's documented operation-not-found error (HTTP 404, status 'error', data.code 111) counts as "not found".
        const notFoundProbe = async (id, entry) => { remote.set(id, entry); try { await plisio.getOperation(id); return null; } catch (error) { return error; } };
        assert.strictEqual((await notFoundProbe('PROBE-NF-1', { __http: 404, body: JSON.stringify({ status: 'error', data: { name: 'Not Found', message: 'x', code: 111 } }) })).providerNotFound, true, 'the documented not-found error is recognised');
        assert.strictEqual((await notFoundProbe('PROBE-NF-2', { __http: 404, body: JSON.stringify({ status: 'error', data: { name: 'Other', code: 5 } }) })).providerNotFound, false, 'an unrelated structured 404 is not "not found"');
        assert.strictEqual((await notFoundProbe('PROBE-NF-3', { __http: 404, body: '<html>Not Found</html>' })).providerNotFound, false, 'a proxy/gateway 404 page is not "not found"');
        assert.strictEqual((await notFoundProbe('PROBE-NF-4', { __http: 503, body: JSON.stringify({ status: 'error', data: { code: 111 } }) })).providerNotFound, false, 'a 5xx is never "not found"');

        // A payment an operator recorded that is only partly applied (access already live) must survive ANY non-completed
        // provider answer: not closed, not provider-terminal, access not retired, no money-loss incident.
        const partly = await attachedIntent('recovery plisio partly recorded', 'plisio', `PLISIO-${unique('partly')}`, null, 'payment', server);
        const partlyRow = await intents.findById(partly.id);
        await require('../src/payments/lifecycle').activatePurchase({
            customerId: partly.owner.id, planId: partly.plan.id, provider: 'plisio', providerSubscriptionId: partly.providerCheckoutId,
            providerStatus: 'completed', commercialSnapshot: { ...partlyRow.commercial_snapshot, checkoutIntentId: partly.id }
        });
        await query(`UPDATE billing_checkout_intents SET operator_resolution='marked_paid_review',operator_resolved_at=NOW() WHERE id=$1`, [partly.id]);
        const incidentsBefore = Number((await query(`SELECT COUNT(*)::int n FROM payment_incidents`)).rows[0].n);
        for (const status of ['expired', 'cancelled', 'cancelled duplicate', 'mismatch', 'error']) {
            remote.set(partly.providerCheckoutId, { ...realShape(partly.providerCheckoutId), status });
            const outcome = await plisio.confirmCheckout(partly.providerCheckoutId, await intents.findById(partly.id));
            assert.strictEqual(outcome.completed, false, `${status} never completes`);
            assert.notStrictEqual(outcome.terminal, true, `${status} must not be treated as a terminal unpaid result for a partly recorded payment`);
        }
        const partlyAfter = (await query(`SELECT state,provider_terminal_at,operator_resolution FROM billing_checkout_intents WHERE id=$1`, [partly.id])).rows[0];
        assert.strictEqual(partlyAfter.provider_terminal_at, null, 'still not provider-terminal');
        assert.strictEqual(partlyAfter.operator_resolution, 'marked_paid_review', 'still waiting in the review queue');
        assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND status='active'`, [partly.owner.id, partly.plan.id])).rows[0].n, 1, 'the access that was already granted survives');
        assert.strictEqual(Number((await query(`SELECT COUNT(*)::int n FROM payment_incidents`)).rows[0].n), incidentsBefore, 'and no money-loss incident was raised');
        // A genuine completion still finishes it.
        remote.set(partly.providerCheckoutId, realShape(partly.providerCheckoutId));
        assert.strictEqual((await plisio.confirmCheckout(partly.providerCheckoutId, await intents.findById(partly.id))).completed, true);
        assert.strictEqual((await query(`SELECT operator_resolution FROM billing_checkout_intents WHERE id=$1`, [partly.id])).rows[0].operator_resolution, 'marked_paid', 'completion resolves the review flag');

        // End to end: the auto-closed invoice is paid late and no callback ever arrives. The worker finds it by itself,
        // activates the plan once, and the intent ends completed.
        remote.set(giveUp.providerCheckoutId, realShape(giveUp.providerCheckoutId));
        const lateRun = await recovery.run({ limit: 100, checkoutIntentIds: [giveUp.id] });
        assert.strictEqual(lateRun.recovered, 1, 'a payment that lands after the invoice was auto-closed is recovered with no callback');
        assert.strictEqual((await stateOf(giveUp.id)).state, 'completed');
        assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND status='active'`, [giveUp.owner.id, giveUp.plan.id])).rows[0].n, 1, 'and the customer holds exactly one active subscription');
        await recovery.run({ limit: 100, checkoutIntentIds: [giveUp.id], ignoreLookback: true });
        // Replaying the activation itself (not just the candidate scan) is idempotent too.
        const giveUpIntent = await intents.findById(giveUp.id);
        assert.strictEqual((await plisio.confirmCheckout(giveUp.providerCheckoutId, giveUpIntent)).completed, true);
        assert.strictEqual((await plisio.confirmCheckout(giveUp.providerCheckoutId, giveUpIntent)).completed, true);
        assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id=$1`, [giveUp.providerCheckoutId])).rows[0].n, 1, 'one ledger row however many times it is confirmed');
        assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM audit_log WHERE action='billing.checkout.dismissed_then_paid' AND entity_id=$1`, [String(giveUp.id)])).rows[0].n, 1, 'the dismissed-then-paid audit is written once');
        assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2`, [giveUp.owner.id, giveUp.plan.id])).rows[0].n, 1, 'replaying the recovery never duplicates it');
    } finally {
        global.fetch = realFetch;
    }

    // An old completed-but-unverifiable payment stops failing the critical job after 72 hours.
    const staleRow = { id: plisioUnverifiable.id, provider: 'plisio', provider_checkout_id: 'PLISIO-STALE', created_at: new Date(Date.now() - 96 * 3600000) };
    const staleOutcome = await recovery.recoverPlisio(staleRow, { plisio: async () => ({ status: 'completed', completed: false, waiting: true }) });
    assert.strictEqual(staleOutcome.state, 'waiting');
    await assert.rejects(
        recovery.recoverPlisio({ ...staleRow, created_at: new Date() }, { plisio: async () => ({ status: 'completed', completed: false, waiting: true }) }),
        /fiat amount could not be verified/
    );

    // Rejected callbacks that reference a real local Plisio checkout are recorded (deduped); noise is ignored.
    const rejected = await attachedIntent('recovery plisio rejected', 'plisio', `PLISIO-${unique('rejected')}`, null, 'payment', server);
    const body = Buffer.from(JSON.stringify({ order_number: rejected.id, txn_id: rejected.providerCheckoutId, status: 'completed', verify_hash: 'bad' }));
    assert.strictEqual(await plisio.recordRejectedCallback(body, new Error('Invalid Plisio callback signature.')), true);
    assert.strictEqual(await plisio.recordRejectedCallback(body, new Error('Invalid Plisio callback signature.')), false, 'repeat rejections inside 10 minutes are not re-recorded');
    assert.strictEqual(await plisio.recordRejectedCallback(Buffer.from(JSON.stringify({ order_number: '00000000-0000-4000-8000-000000000000' })), new Error('x')), false);
    assert.strictEqual(await plisio.recordRejectedCallback(Buffer.from('not json'), new Error('x')), false);
    const logged = await query(`SELECT metadata FROM audit_log WHERE action='payment.plisio.callback_rejected' AND entity_id=$1`, [rejected.id]);
    assert.strictEqual(logged.rowCount, 1);
    assert(/signature/.test(logged.rows[0].metadata.reason));

    console.log('provider checkout recovery DB smoke: retry isolation, pending safety and terminal convergence ok');
}

runDbSmoke('provider checkout recovery DB smoke', async () => {
    try {
        await main();
    } finally {
        await cleanup();
    }
}).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
