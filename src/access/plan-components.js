'use strict';

const modules = require('../modules/registry');
const drivers = require('./drivers');
const serviceCatalog = require('../catalog/service-catalog');

function serviceType(plan) { return serviceCatalog.serviceType(plan); }

function jellyfinHouseholdConfig(plan) {
  return drivers.householdConfig({
    household_network_limit: plan?.jellyfin_household_network_limit,
    household_lease_minutes: plan?.jellyfin_household_lease_minutes
  });
}

function stremioReplacementPolicy(plan) {
  return String(plan?.stremio_ip_replacement_policy || 'auto_inactive') === 'customer_cooldown' ? 'customer_cooldown' : 'auto_inactive';
}

function stremioHouseholdConfig(plan) {
  const config = drivers.householdConfig({
    household_network_limit: plan?.stremio_household_network_limit,
    household_lease_minutes: plan?.stremio_household_lease_minutes
  });
  const replacementPolicy = stremioReplacementPolicy(plan);
  const cooldownMinutes = drivers.boundedInt(plan?.stremio_ip_replacement_cooldown_minutes, 15, 1440, 1440);
  return {
    ...config,
    leaseMinutes: replacementPolicy === 'customer_cooldown' ? Math.max(config.leaseMinutes, cooldownMinutes) : config.leaseMinutes,
    replacementPolicy,
    cooldownMinutes
  };
}

function mediaComponent(plan, type) {
  const driver = drivers.normalizeDriver(plan.jellyfin_access_model, 'concurrent_streams');
  return {
    module: type,
    capability: driver === 'household_network' ? `${type}.household_network` : `${type}.concurrent_streams`,
    driver,
    config: driver === 'household_network' ? jellyfinHouseholdConfig(plan) : drivers.concurrentStreamConfig(plan)
  };
}

function componentsForPlan(plan) {
  if (!plan) return [];
  const type = serviceType(plan);
  const output = [];

  if (type === 'jellyfin' || type === 'bundle') output.push(mediaComponent(plan, 'jellyfin'));
  if (type === 'emby') output.push(mediaComponent(plan, 'emby'));

  if (type === 'stremio' || type === 'bundle') {
    output.push({
      module: 'stremio',
      capability: 'stremio.household_network',
      driver: 'household_network',
      config: stremioHouseholdConfig(plan)
    });
  }

  return output;
}

function componentForPlan(plan, moduleId) {
  return componentsForPlan(plan).find(component => component.module === String(moduleId || '').toLowerCase()) || null;
}

function assertComponentsLicensed(plan, options = {}) {
  for (const component of componentsForPlan(plan)) modules.assertEnabled(component.module, options);
  return true;
}

function accessLabel(plan) {
  const parts = componentsForPlan(plan).map(component => {
    if (component.module === 'stremio') {
      const households = component.config.networkLimit;
      return `Unlimited streams · Unlimited devices · ${households} household connection${households === 1 ? '' : 's'}`;
    }
    const serviceLabel = component.module === 'emby' ? 'Emby' : 'Jellyfin';
    if (component.driver === 'household_network') return `${component.config.networkLimit} ${serviceLabel} household network${component.config.networkLimit === 1 ? '' : 's'}`;
    return `${component.config.streamLimit} ${serviceLabel} stream${component.config.streamLimit === 1 ? '' : 's'}`;
  });
  return parts.join(' · ');
}

module.exports = { serviceType, jellyfinHouseholdConfig, stremioReplacementPolicy, stremioHouseholdConfig, componentsForPlan, componentForPlan, assertComponentsLicensed, accessLabel };
