'use strict';

const pkg = require('../../package.json');
const { safeFetch } = require('../security/outbound-url-policy');

const REPOSITORY = 'Ricas13/fin-fusion';
const MAIN_COMMIT_URL = `https://api.github.com/repos/${REPOSITORY}/commits/main`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cached = null;
let inflight = null;

function normalizeSha(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(raw) ? raw : '';
}

function normalizeBuiltAt(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function buildMetadata(env = process.env) {
  return {
    version: String(pkg.version || 'unknown'),
    sha: normalizeSha(env.CAPTAINFIN_BUILD_SHA),
    builtAt: normalizeBuiltAt(env.CAPTAINFIN_BUILD_TIME)
  };
}

function checkingEnabled(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'test') return false;
  return !/^(0|false|off|no)$/i.test(String(env.CAPTAINFIN_UPDATE_CHECK_ENABLED || 'true').trim());
}

function stateFromComparison(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'identical') return 'current';
  if (value === 'ahead') return 'update_available';
  if (value === 'behind' || value === 'diverged') return 'custom_build';
  return 'unknown_build';
}

function stateLabel(state) {
  return {
    current: 'Up to date',
    update_available: 'Update available',
    custom_build: 'Custom build',
    unknown_build: 'Build unknown',
    unavailable: 'Check unavailable',
    disabled: 'Update checks off'
  }[state] || 'Unknown';
}

function publicStatus(value) {
  return {
    state: value.state,
    label: stateLabel(value.state),
    version: value.local.version,
    buildSha: value.local.sha || null,
    buildShort: value.local.sha ? value.local.sha.slice(0, 8) : null,
    builtAt: value.local.builtAt || null,
    upstreamSha: value.upstreamSha || null,
    upstreamShort: value.upstreamSha ? value.upstreamSha.slice(0, 8) : null,
    upstreamAt: value.upstreamAt || null,
    checkedAt: value.checkedAt || null,
    compareUrl: value.compareUrl || null,
    error: value.error || null
  };
}

async function fetchJson(url) {
  const response = await safeFetch(url, {
    purpose: 'CAPTAiNFiN update check',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `CAPTAiNFiN/${pkg.version || 'unknown'}`
    },
    timeoutMs: 7000,
    maxBytes: 1024 * 1024
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  return response.json();
}

async function performCheck() {
  const local = buildMetadata();
  const checkedAt = new Date().toISOString();
  if (!checkingEnabled()) return { state: 'disabled', local, checkedAt };

  try {
    const main = await fetchJson(MAIN_COMMIT_URL);
    const upstreamSha = normalizeSha(main.sha);
    const upstreamAt = normalizeBuiltAt(main.commit?.committer?.date || main.commit?.author?.date);
    if (!upstreamSha) throw new Error('GitHub did not return a valid main commit SHA');

    if (!local.sha) {
      return { state: 'unknown_build', local, upstreamSha, upstreamAt, checkedAt };
    }
    if (local.sha === upstreamSha) {
      return { state: 'current', local, upstreamSha, upstreamAt, checkedAt };
    }

    const compareUrl = `https://github.com/${REPOSITORY}/compare/${local.sha}...main`;
    const compareApi = `https://api.github.com/repos/${REPOSITORY}/compare/${local.sha}...${upstreamSha}`;
    const comparison = await fetchJson(compareApi);
    return {
      state: stateFromComparison(comparison.status),
      local,
      upstreamSha,
      upstreamAt,
      checkedAt,
      compareUrl
    };
  } catch (error) {
    return {
      state: 'unavailable',
      local,
      checkedAt,
      error: String(error?.message || 'Update check failed').slice(0, 300)
    };
  }
}

async function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (inflight) return inflight;
  inflight = performCheck().then(value => {
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }).finally(() => { inflight = null; });
  return inflight;
}

function clearCache() {
  cached = null;
}

module.exports = {
  REPOSITORY,
  MAIN_COMMIT_URL,
  CACHE_TTL_MS,
  buildMetadata,
  checkingEnabled,
  stateFromComparison,
  stateLabel,
  publicStatus,
  checkForUpdate,
  clearCache,
  normalizeSha
};
