'use strict';

function text(value, fallback = '—') {
  const normalized = String(value == null ? '' : value).trim();
  return normalized || fallback;
}
function serviceType(row) {
  return String(row?.service_type_snapshot || row?.service_type || '').trim().toLowerCase();
}
function supports(row, service) {
  const type = serviceType(row);
  return type === service || type === 'bundle';
}
function currentSubscriptions(detail) {
  const now = Date.now();
  return (detail?.subscriptions || []).filter(row => {
    if (!['active','trialing','past_due','paused'].includes(String(row?.status || ''))) return false;
    const end = row?.current_period_end ? new Date(row.current_period_end).getTime() : Infinity;
    return !Number.isFinite(end) || end > now;
  });
}
function snapshot(detail) {
  const state = detail?.provisioningState || {};
  return state.last_result || state.detail?.result || {};
}
function accountLabel(account) {
  if (!account) return 'No account recorded';
  const identity = account.jellyfin_username || account.emby_username || account.username || account.id || 'account';
  return account.server_name ? `${identity} · ${account.server_name}` : String(identity);
}
function laneActual(lane, fallbackAccount = null) {
  if (lane) {
    if (lane.blocked) return 'Blocked';
    return lane.active ? 'Active' : 'Inactive';
  }
  if (fallbackAccount) return fallbackAccount.disabled ? 'Disabled' : 'Enabled';
  return 'No reconciliation snapshot';
}
function laneDesired(lane, entitled) {
  if (lane?.blocked) return 'Blocked by access hold';
  if (lane) return lane.active ? 'Enabled' : entitled ? 'Enabled' : 'Not required';
  return entitled ? 'Enabled' : 'Not required';
}
function lanePlan(lane, entitlement) {
  return text(lane?.planCode || entitlement?.contract_plan_code || entitlement?.plan_code || entitlement?.code || entitlement?.plan_name || entitlement?.name, '—');
}
function resultRows(detail) {
  const state = detail?.provisioningState || {};
  const result = snapshot(detail);
  const live = currentSubscriptions(detail);
  const loadedPrimary = detail?.primaryEntitlement || null;
  const loadedFree = detail?.freeEntitlement || null;
  const primaryEntitlement = loadedPrimary && supports(loadedPrimary, 'jellyfin') && !loadedPrimary.is_free_tier
    ? loadedPrimary
    : live.find(row => supports(row, 'jellyfin') && !row.is_free_tier) || null;
  const freeEntitlement = loadedFree && supports(loadedFree, 'jellyfin') && loadedFree.is_free_tier
    ? loadedFree
    : live.find(row => supports(row, 'jellyfin') && row.is_free_tier) || null;
  const embyEntitlement = loadedPrimary && supports(loadedPrimary, 'emby')
    ? loadedPrimary
    : live.find(row => supports(row, 'emby')) || null;
  const stremioEntitlement = loadedPrimary && supports(loadedPrimary, 'stremio')
    ? loadedPrimary
    : live.find(row => supports(row, 'stremio')) || null;
  const accounts = (detail?.accounts || []).filter(row => String(row?.account_purpose || 'jellyfin') !== 'stremio_internal');
  const primaryAccount = accounts.find(row => String(row?.access_lane || 'primary') === 'primary') || null;
  const freeAccount = accounts.find(row => String(row?.access_lane || '') === 'free') || null;
  const embyAccounts = detail?.embyAccounts || detail?.mediaAccounts?.filter?.(row => String(row?.media_server_type || '').toLowerCase() === 'emby') || [];
  const globalError = state.last_error ? String(state.last_error).slice(0, 500) : null;
  const blockers = Array.isArray(result.blockers) ? result.blockers : (detail?.activeHolds || []).map(row => row.hold_type || row.type || 'hold');
  const blockerText = blockers.length ? blockers.map(row => typeof row === 'string' ? row : row.type || row.hold_type || 'hold').join(', ') : null;
  const reconciledAt = result.reconciledAt || state.last_success_at || state.last_attempt_at || null;

  return [
    {
      key: 'jellyfin-primary', service: 'Jellyfin primary', desired: laneDesired(result.primary, Boolean(primaryEntitlement)),
      actual: laneActual(result.primary, primaryAccount), plan: lanePlan(result.primary, primaryEntitlement),
      target: result.primary?.accountId || result.primary?.serverId ? [result.primary.accountId, result.primary.serverId].filter(Boolean).join(' · ') : accountLabel(primaryAccount),
      issue: result.primary?.blocked ? blockerText || 'Access hold' : globalError, reconciledAt
    },
    {
      key: 'jellyfin-free', service: 'Jellyfin Free', desired: laneDesired(result.free, Boolean(freeEntitlement)),
      actual: laneActual(result.free, freeAccount), plan: lanePlan(result.free, freeEntitlement),
      target: result.free?.accountId || result.free?.serverId ? [result.free.accountId, result.free.serverId].filter(Boolean).join(' · ') : accountLabel(freeAccount),
      issue: result.free?.blocked ? blockerText || 'Access hold' : null, reconciledAt
    },
    {
      key: 'emby', service: 'Emby', desired: laneDesired(result.emby, Boolean(embyEntitlement)),
      actual: laneActual(result.emby, embyAccounts[0] || null), plan: lanePlan(result.emby, embyEntitlement),
      target: result.emby?.accountId || result.emby?.serverId ? [result.emby.accountId, result.emby.serverId].filter(Boolean).join(' · ') : accountLabel(embyAccounts[0] || null),
      issue: result.emby?.blocked ? blockerText || 'Access hold' : null, reconciledAt
    },
    {
      key: 'stremio', service: 'Stremio', desired: stremioEntitlement ? 'Enabled' : (result.stremioStatus ? 'Enabled' : 'Not required'),
      actual: result.stremioStatus ? text(result.stremioStatus) : 'No reconciliation snapshot', plan: lanePlan(null, stremioEntitlement),
      target: result.serverId ? String(result.serverId) : 'Managed Stremio delivery', issue: null, reconciledAt
    },
    {
      key: 'discord', service: 'Discord roles', desired: live.length || loadedPrimary ? 'Synced to active plans' : 'No active plan roles',
      actual: result.discordStatus ? text(result.discordStatus) : 'No reconciliation snapshot', plan: 'Active plan roles',
      target: 'Discord integration', issue: null, reconciledAt
    }
  ];
}

module.exports = { resultRows, snapshot, currentSubscriptions, laneActual, laneDesired, serviceType, supports };
