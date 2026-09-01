'use strict';

const DEFINITIONS = Object.freeze({
  jellyfin: Object.freeze({
    id: 'jellyfin',
    label: 'Jellyfin',
    planLabel: 'Jellyfin',
    pluralLabel: 'Jellyfin plans',
    mediaServerType: 'jellyfin',
    module: 'jellyfin',
    storefront: Object.freeze({ id: 'plans', navLabel: 'Plans', kicker: 'Paid server plans', title: 'Jellyfin plans', description: 'Choose the Jellyfin server access that fits you.' })
  }),
  stremio: Object.freeze({
    id: 'stremio',
    label: 'Stremio',
    planLabel: 'Stremio',
    pluralLabel: 'Stremio plans',
    mediaServerType: null,
    module: 'stremio',
    storefront: Object.freeze({ id: 'stremio', navLabel: 'Stremio', kicker: 'Stremio plans', title: 'Stremio plans', description: 'Standalone Stremio access.' })
  }),
  emby: Object.freeze({
    id: 'emby',
    label: 'Emby',
    planLabel: 'Emby Share',
    pluralLabel: 'Emby Shares',
    mediaServerType: 'emby',
    module: 'emby',
    storefront: Object.freeze({ id: 'emby', navLabel: 'Emby Shares', kicker: 'Emby shares', title: 'Emby Shares', description: 'Standalone Emby server access managed from the same customer account.' })
  }),
  bundle: Object.freeze({
    id: 'bundle',
    label: 'Jellyfin + Stremio',
    planLabel: 'Legacy bundle',
    pluralLabel: 'Legacy bundles',
    mediaServerType: null,
    module: null,
    historical: true
  })
});

const SERVICE_TYPES = Object.freeze(Object.keys(DEFINITIONS));

function rawType(value) {
  if (value && typeof value === 'object') {
    return value.service_type_snapshot || value.service_type || value.serviceType || 'jellyfin';
  }
  return value || 'jellyfin';
}

function serviceType(value) {
  const normalized = String(rawType(value)).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, normalized) ? normalized : 'jellyfin';
}

function definition(value) {
  return DEFINITIONS[serviceType(value)];
}

function label(value) {
  return definition(value).label;
}

function planLabel(value) {
  return definition(value).planLabel;
}

function mediaServerType(value) {
  return definition(value).mediaServerType;
}

function isMediaServerService(value) {
  return Boolean(mediaServerType(value));
}

function capabilities(value) {
  const type = serviceType(value);
  return type === 'bundle' ? Object.freeze(['jellyfin', 'stremio']) : Object.freeze([type]);
}

function publicPlans(plans = []) {
  return (plans || []).filter(plan => plan && !plan.is_addon && serviceType(plan) !== 'bundle');
}

function storefrontGroups(plans = []) {
  const groups = { free: [], plans: [], stremio: [], emby: [] };
  for (const plan of publicPlans(plans)) {
    const type = serviceType(plan);
    if (type === 'jellyfin') {
      (plan.is_free_tier ? groups.free : groups.plans).push(plan);
    } else if (type === 'stremio') {
      groups.stremio.push(plan);
    } else if (type === 'emby') {
      groups.emby.push(plan);
    }
  }
  return groups;
}

function storefrontSections(plans = []) {
  const groups = storefrontGroups(plans);
  return ['jellyfin', 'stremio', 'emby']
    .map(type => {
      const def = DEFINITIONS[type];
      const rows = type === 'jellyfin' ? groups.plans : groups[type];
      return { ...def.storefront, serviceType: type, plans: rows };
    })
    .filter(section => section.plans.length > 0);
}

module.exports = {
  DEFINITIONS,
  SERVICE_TYPES,
  serviceType,
  definition,
  label,
  planLabel,
  mediaServerType,
  isMediaServerService,
  capabilities,
  publicPlans,
  storefrontGroups,
  storefrontSections
};
