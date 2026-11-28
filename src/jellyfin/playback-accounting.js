'use strict';

const { transaction } = require('../db');
const accounting = require('./playback-accounting-core');

let lastErrorWarningAt = 0;

function enabled() {
  return process.env.PLAYBACK_ACCOUNTING_SHADOW_ENABLED === 'true';
}

/**
 * Side-by-side observation ledger stored on the existing playback_history row.
 * This code never mutates started_at, ended_at, last_seen_at, entitlement
 * state, or the duration calculations used by the customer portal.
 */
async function record(input) {
  if (!enabled()) return { skipped: 'disabled' };
  if (!input?.serverId || !input?.playbackKey) return { skipped: 'no_identity' };
  const eventAt = new Date(input.at);
  if (!Number.isFinite(eventAt.getTime()) ||
      eventAt.getTime() > Date.now() + 120000) return { skipped: 'invalid_timestamp' };

  return transaction(async client => {
    const result = await client.query(`
      SELECT id,started_at,ended_at,
             observed_watch_seconds,observed_confirmed_seconds,
             observed_anchor_at,observed_last_at,
             observed_last_position_ticks,observed_last_paused,
             observed_sample_count,observed_last_source,observed_ended
      FROM playback_history
      WHERE server_id=$1 AND playback_key=$2
      FOR UPDATE
    `, [input.serverId, input.playbackKey]);
    if (!result.rowCount) return { skipped: 'history_not_found' };
    const row = result.rows[0];
    if (row.ended_at && input.event !== 'stop') return { skipped: 'already_ended' };

    const previous = row.observed_last_at ? {
      startedAt: row.observed_anchor_at,
      observedAt: row.observed_last_at,
      positionTicks: row.observed_last_position_ticks,
      isPaused: row.observed_last_paused,
      watchSeconds: row.observed_watch_seconds,
      confirmedSeconds: row.observed_confirmed_seconds,
      samples: row.observed_sample_count,
      lastSource: row.observed_last_source,
      ended: row.observed_ended
    } : null;
    const next = accounting.advance(previous, {
      ...input, at: eventAt, startedAt: row.started_at
    });
    if (!next || next === previous) return { skipped: 'out_of_order' };

    await client.query(`
      UPDATE playback_history SET
        observed_watch_seconds=$2,
        observed_confirmed_seconds=$3,
        observed_anchor_at=$4,
        observed_last_at=$5,
        observed_last_position_ticks=$6,
        observed_last_paused=$7,
        observed_sample_count=$8,
        observed_last_source=$9,
        observed_ended=$10
      WHERE id=$1
    `, [
      row.id, next.watchSeconds, next.confirmedSeconds,
      next.startedAt, next.observedAt, next.positionTicks,
      next.isPaused, next.samples, next.lastSource, next.ended
    ]);
    return {
      recorded: true,
      watchedSeconds: next.watchSeconds,
      confirmedSeconds: next.confirmedSeconds,
      observations: next.samples
    };
  });
}

// Shadow write failures must not break legacy playback capture or stream
// policies; report a bounded warning until an operator can investigate.
async function recordSafely(input) {
  if (!enabled()) return;
  try {
    await record(input);
  } catch (error) {
    if (Date.now() - lastErrorWarningAt > 60000) {
      lastErrorWarningAt = Date.now();
      console.warn('Native shadow playback accounting failed:', error.message);
    }
  }
}

module.exports = { enabled, record, recordSafely };
