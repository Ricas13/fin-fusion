'use strict';

// Native playback observation accounting. Pure state transition logic so events
// from polling and webhooks use the same rules. No external service or player
// integration is required.
const TICKS_PER_SECOND = 10000000;
const MAX_TOTAL_SECONDS = 12 * 3600;
const MAX_POLL_GAP_SECONDS = 90;
const MAX_WEBHOOK_GAP_SECONDS = 4 * 3600;

function finiteSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function position(value) {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Record one observation of the current playback segment.
 *
 * The first sighting never invents playback before it was observed.
 * Subsequent unpaused intervals earn at most the observed wall-clock gap.
 * Polling gaps are bounded to avoid manufacturing watch time during outages.
 * Explicit webhook transitions can bridge longer intervals but remain
 * estimates unless the playback position independently advanced.
 *
 * A pause stops subsequent accrual, and duplicate/out-of-order events are
 * idempotent. Position seeks are never converted into extra watch time.
 */
function advance(previous = null, sample, options = {}) {
  const at = validDate(sample?.at);
  const startedAt = validDate(sample?.startedAt);
  if (!at || !startedAt) throw new Error('A valid observation and segment start are required.');
  if (at.getTime() < startedAt.getTime() - 1000) {
    return previous || null; // Old webhook event from before this segment.
  }
  const observedAt = validDate(previous?.observedAt);
  const anchor = validDate(previous?.startedAt);
  const sameSegment = anchor && anchor.getTime() === startedAt.getTime();
  const prior = sameSegment ? previous : null;
  const ticks = position(sample.positionTicks);
  const isPaused = sample.isPaused === true;
  const source = sample.source === 'webhook' ? 'webhook' : 'poll';
  const event = ['start', 'progress', 'pause', 'resume', 'stop'].includes(sample.event)
    ? sample.event : 'progress';
  const base = {
    startedAt,
    observedAt: at,
    positionTicks: ticks,
    isPaused: event === 'stop' ? true : isPaused,
    watchSeconds: finiteSeconds(prior?.watchSeconds),
    confirmedSeconds: finiteSeconds(prior?.confirmedSeconds),
    samples: Math.max(0, Number(prior?.samples) || 0) + 1,
    lastSource: source,
    ended: event === 'stop'
  };

  if (!observedAt || !prior) return base;
  if (at.getTime() <= observedAt.getTime() || prior.ended) return previous;

  const elapsed = Math.max(0, (at.getTime() - observedAt.getTime()) / 1000);
  const cap = source === 'webhook'
    ? finiteSeconds(options.maxWebhookGapSeconds ?? MAX_WEBHOOK_GAP_SECONDS)
    : finiteSeconds(options.maxPollGapSeconds ?? MAX_POLL_GAP_SECONDS);

  let credited = 0;
  let confirmed = 0;
  if (prior.isPaused === false && elapsed > 0) {
    credited = Math.min(elapsed, cap);
    const before = position(prior.positionTicks);
    const moved = before != null && ticks != null
      ? (ticks - before) / TICKS_PER_SECOND : null;
    if (moved != null && moved > 0 && moved <= elapsed + 15) {
      // A progressing position corroborates this interval. It may still skip
      // forward through a seek, so it cannot increase credit past elapsed.
      credited = Math.min(credited, moved + 2);
      confirmed = credited;
    }
    // If the position did not move, clock time is an estimate, not proof.
    // It is retained separately from the confirmed total.
  }

  base.watchSeconds = Math.min(MAX_TOTAL_SECONDS, base.watchSeconds + credited);
  base.confirmedSeconds = Math.min(base.watchSeconds, base.confirmedSeconds + confirmed);
  return base;
}

module.exports = {
  advance,
  TICKS_PER_SECOND,
  MAX_TOTAL_SECONDS,
  MAX_POLL_GAP_SECONDS,
  MAX_WEBHOOK_GAP_SECONDS
};
