'use strict';

const { query } = require('../db');
const playbackAnalytics = require('./playback-analytics');

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRow(row = {}) {
  return {
    peakConcurrentStreams: numeric(row.peak_concurrent_streams),
    sampleCount: numeric(row.sample_count),
    coverageStart: row.coverage_start || null,
    coverageEnd: row.coverage_end || null
  };
}

async function readRange(range) {
  const result = await query(
    'SELECT * FROM public.playback_concurrency_metrics($1::timestamptz,$2::timestamptz)',
    [range.start, range.end]
  );
  return normalizeRow(result.rows?.[0]);
}

async function load(range) {
  const previousRange = {
    start: range.previousStart,
    end: range.previousEnd
  };
  const [current, previous] = await Promise.all([
    readRange(range),
    readRange(previousRange)
  ]);
  return { current, previous };
}

function applyToAnalytics(analytics, observed) {
  if (!analytics || !analytics.metrics || !analytics.comparisons) return analytics;
  const current = observed?.current || normalizeRow();
  const previous = observed?.previous || normalizeRow();

  analytics.metrics.peakConcurrentStreams = current.peakConcurrentStreams;
  analytics.metrics.peakConcurrentStreamsSampleCount = current.sampleCount;
  analytics.metrics.peakConcurrentStreamsCoverageStart = current.coverageStart;
  analytics.metrics.peakConcurrentStreamsCoverageEnd = current.coverageEnd;
  analytics.metrics.peakConcurrentStreamsSource = 'fleet_samples';

  analytics.comparisons.peakConcurrentStreams = current.sampleCount > 0
    ? playbackAnalytics.comparison(current.peakConcurrentStreams, previous.peakConcurrentStreams)
    : { direction: 'flat', tone: 'neutral', percent: 0, label: 'No trusted samples yet' };

  return analytics;
}

module.exports = { normalizeRow, readRange, load, applyToAnalytics };
