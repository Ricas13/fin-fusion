'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const lifecycle = require('../src/payments/lifecycle-primitives');

async function main() {
  const suffix = crypto.randomBytes(8).toString('hex');
  const concurrentId = `ci-replay-${suffix}`;
  const retryId = `ci-retry-${suffix}`;
  try {
    // Two workers/tabs receiving the same provider event concurrently must
    // produce exactly one processing lease. The unique ledger key is the
    // correctness boundary; the loser must observe null rather than process.
    const claims = await Promise.all([
      lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: concurrentId, eventType: 'ci.replay', payload: { sequence: 1 } }),
      lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: concurrentId, eventType: 'ci.replay', payload: { sequence: 1 } })
    ]);
    const winners = claims.filter(Boolean);
    assert.strictEqual(winners.length, 1, 'concurrent replay must create exactly one payment-event processing lease');
    assert.strictEqual(await lifecycle.finishPaymentEvent(winners[0]), true, 'winning payment-event lease must complete');
    const replay = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: concurrentId, eventType: 'ci.replay', payload: { sequence: 2 } });
    assert.strictEqual(replay, null, 'processed provider event must never become processable again even if replay payload changes');
    const stored = await query(`SELECT COUNT(*)::int n,MIN(processed_at) AS processed_at FROM payment_events WHERE provider='stripe' AND provider_event_id=$1`, [concurrentId]);
    assert.strictEqual(Number(stored.rows[0].n), 1, 'provider replay must keep one durable ledger row');
    assert(stored.rows[0].processed_at, 'successful event must remain durably marked processed');

    // A failed event is retryable, but not immediately. This prevents a second
    // request from racing the failed worker before the bounded retry delay.
    const failed = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: retryId, eventType: 'ci.retry', payload: { sequence: 1 } });
    assert(failed, 'failed-event fixture must acquire an initial lease');
    assert.strictEqual(await lifecycle.finishPaymentEvent(failed, new Error('fixture failure')), true, 'failed payment-event lease must persist its failure');
    const tooSoon = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: retryId, eventType: 'ci.retry', payload: { sequence: 2 } });
    assert.strictEqual(tooSoon, null, 'failed payment event must respect retry delay before it can be reclaimed');

    // Once the retry window is old enough, one worker may reclaim it with a new
    // token. This proves failure does not turn idempotency into permanent loss.
    await query(`UPDATE payment_events SET processing_started_at=NOW()-INTERVAL '10 minutes' WHERE provider='stripe' AND provider_event_id=$1`, [retryId]);
    const reclaimed = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: retryId, eventType: 'ci.retry', payload: { sequence: 3 } });
    assert(reclaimed?.processing_token, 'aged failed event must become reclaimable with a fresh processing lease');
    assert.notStrictEqual(String(reclaimed.processing_token), String(failed.processing_token), 'reclaimed event must receive a fresh lease token');
    assert.strictEqual(await lifecycle.finishPaymentEvent(reclaimed), true, 'reclaimed event must be able to complete normally');

    console.log('payment event replay DB smoke: OK');
  } finally {
    await query(`DELETE FROM payment_events WHERE provider='stripe' AND provider_event_id=ANY($1::text[])`, [[concurrentId, retryId]]).catch(() => {});
    await getPool().end();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
