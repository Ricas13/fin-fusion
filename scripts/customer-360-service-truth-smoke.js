'use strict';

const assert = require('assert');
const view = require('../src/platform/customer-360-view');

const future = new Date(Date.now() + 86400000).toISOString();
const detail = {
  customer: { id: 'customer-fixture', display_name: 'Service Truth Fixture' },
  subscriptions: [
    { status: 'active', current_period_end: future, service_type: 'jellyfin', plan_code: 'premium' },
    { status: 'active', current_period_end: future, service_type: 'stremio', plan_code: 'stremio' }
  ],
  primaryEntitlement: { status: 'active', service_type: 'jellyfin', contract_plan_code: 'premium' },
  accounts: [{ id: 'account-1', access_lane: 'primary', account_purpose: 'jellyfin', disabled: false, jellyfin_username: 'fixture', server_name: 'Premium Server' }],
  activeHolds: [],
  provisioningState: {
    status: 'healthy',
    last_success_at: '2026-09-03T09:30:00.000Z',
    last_result: {
      primary: { active: true, blocked: false, planCode: 'premium', accountId: 'account-1', serverId: 'server-1' },
      free: null,
      emby: null,
      stremioStatus: 'active',
      discordStatus: 'synced',
      blockers: [],
      reconciledAt: '2026-09-03T09:30:00.000Z'
    }
  }
};

const html = view.accessTruthPanel(detail);
assert(html.includes('Service reconciliation truth'));
assert(html.includes('Jellyfin primary'));
assert(html.includes('Jellyfin Free'));
assert(html.includes('Emby'));
assert(html.includes('Stremio'));
assert(html.includes('Discord roles'));
assert(html.includes('account-1 · server-1'));
assert(html.includes('No reconciliation snapshot'), 'unobserved lanes must remain explicitly unknown');
assert(html.indexOf('Desired') < html.indexOf('Observed'));

console.log('Customer 360 service truth renderer smoke: OK');
