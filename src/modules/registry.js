'use strict';

const MODULES = Object.freeze({
  core: Object.freeze({ id: 'core', label: 'CAPTAiNFiN Core', free: true, capabilities: ['platform.core'] }),
  jellyfin: Object.freeze({ id: 'jellyfin', label: 'Jellyfin', free: false, capabilities: ['jellyfin.access', 'jellyfin.concurrent_streams', 'jellyfin.household_network'] }),
  stremio: Object.freeze({ id: 'stremio', label: 'Stremio', free: false, capabilities: ['stremio.access', 'stremio.household_network'] }),
  emby: Object.freeze({ id: 'emby', label: 'Emby', free: false, capabilities: ['emby.access', 'emby.concurrent_streams', 'emby.household_network'] }),
  affiliate: Object.freeze({ id: 'affiliate', label: 'Affiliate', free: false, capabilities: ['affiliate.access'] })
});

function ids() {
  return Object.keys(MODULES);
}

function definition(id) {
  return MODULES[String(id || '').trim().toLowerCase()] || null;
}

function parseConfiguredModules(raw = process.env.CAPTAINFIN_ENABLED_MODULES) {
  // Compatibility mode deliberately enables every currently shipped module.
  // The registry remains the neutral extension seam for a future project to
  // add separately-owned modules without CAPTAiNFiN shipping their product UI.
  if (raw == null || String(raw).trim() === '') return new Set(ids());
  const configured = new Set(
    String(raw)
      .split(',')
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .filter(value => Boolean(definition(value)))
  );
  configured.add('core');
  return configured;
}

function snapshot(options = {}) {
  const enabled = parseConfiguredModules(options.enabledModules);
  const deploymentMode = ['self_hosted', 'hosted'].includes(String(options.deploymentMode || process.env.CAPTAINFIN_DEPLOYMENT_MODE || '').toLowerCase())
    ? String(options.deploymentMode || process.env.CAPTAINFIN_DEPLOYMENT_MODE).toLowerCase()
    : 'self_hosted';
  const tenantKey = String(options.tenantKey || 'default').trim() || 'default';
  return {
    deploymentMode,
    tenantKey,
    source: options.source || (options.enabledModules == null && !process.env.CAPTAINFIN_ENABLED_MODULES ? 'legacy_compatibility' : 'configured'),
    modules: ids().map(id => ({ ...MODULES[id], enabled: enabled.has(id) }))
  };
}

function isEnabled(id, options = {}) {
  const found = snapshot(options).modules.find(module => module.id === String(id || '').toLowerCase());
  return Boolean(found?.enabled);
}

function assertEnabled(id, options = {}) {
  const item = definition(id);
  if (!item) throw new Error(`Unknown CAPTAiNFiN module: ${id}`);
  if (!isEnabled(id, options)) {
    const error = new Error(`${item.label} module is not licensed for this installation.`);
    error.code = 'MODULE_NOT_ENABLED';
    throw error;
  }
  return item;
}

module.exports = { MODULES, ids, definition, parseConfiguredModules, snapshot, isEnabled, assertEnabled };
