'use strict';

const modules = require('../modules/registry');
const drivers = require('./drivers');

function serviceType(plan) {
  const value = String(plan?.service_type_snapshot || plan?.service_type || 'jellyfin').toLowerCase();
  return value === 'stremio' || value === 'bundle' ? value : 'jellyfin';
}

function jellyfinHouseholdConfig(plan) {
  return drivers.householdConfig({
    household_network_limit: plan?.jellyfin_household_network_limit,
    household_lease_minutes: plan?.jellyfin_household_lease_minutes
  });
}

function stremioHouseholdConfig(plan) {
  const config = drivers.householdConfig({
    household_network_limit: 1,
    household_lease_minutes: plan?.stremio_household_lease_minutes
  });
  return { ...config, networkLimit: 1 };
}

function componentsForPlan(plan) {
  if (!plan) return [];
  const type = serviceType(plan);
  const output = [];

  if (type === 'jellyfin' || type === 'bundle') {
    const driver = drivers.normalizeDriver(plan.jellyfin_access_model, 'concurrent_streams');
    output.push({
      module: 'jellyfin',
      capability: driver === 'household_network' ? 'jellyfin.household_network' : 'jellyfin.concurrent_streams',
      driver,
      config: driver === 'household_network' ? jellyfinHouseholdConfig(plan) : drivers.concurrentStreamConfig(plan)
    });
  }

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
    if (component.module === 'stremio') return '1 Stremio household';
    if (component.driver === 'household_network') return `${component.config.networkLimit} Jellyfin household network${component.config.networkLimit === 1 ? '' : 's'}`;
    return `${component.config.streamLimit} Jellyfin stream${component.config.streamLimit === 1 ? '' : 's'}`;
  });
  return parts.join(' · ');
}

module.exports = { serviceType, jellyfinHouseholdConfig, stremioHouseholdConfig, componentsForPlan, componentForPlan, assertComponentsLicensed, accessLabel };
