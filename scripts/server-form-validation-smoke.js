'use strict';

process.env.NODE_ENV = 'production';
delete process.env.JELLYFIN_ALLOWED_HOSTS;

const fs = require('fs');
const path = require('path');
const { parseServerForm, safeAdminErrorInfo } = require('../src/platform/admin-servers');
const inactivity = require('../src/automation/customer-inactivity');
const webhookAuth = require('../src/jellyfin/playback-webhook-auth');
const webhookToken = require('./jellyfin-webhook-token');

const valid = {
    name: 'Primary',
    slug: 'primary-server',
    serverClass: 'premium',
    mediaServerType: 'jellyfin',
    baseUrl: 'https://allowed.example',
    publicUrl: 'https://watch.example',
    location: 'UK',
    priority: '100',
    maxUsers: '',
    allowNewUsers: 'on',
    trialEnabled: 'on',
    paidEnabled: 'on',
    apiKey: '1234567890abcdef1234567890abcdef'
};

function expectField(field, changes, contains) {
    let thrown = null;
    try { parseServerForm({ ...valid, ...changes }, { apiKeyRequired: true }); }
    catch (error) { thrown = error; }
    if (!thrown) throw new Error(`Expected ${field} validation to fail`);
    const info = safeAdminErrorInfo(thrown);
    if (info.field !== field) throw new Error(`Expected field ${field}, got ${info.field || 'none'}: ${info.message}`);
    if (contains && !info.message.includes(contains)) throw new Error(`Expected ${field} error to contain ${contains}: ${info.message}`);
}

expectField('name', { name: '' }, 'required');
expectField('slug', { slug: 'A' }, '3-60');
expectField('serverClass', { serverClass: 'invalid' }, 'Invalid');
expectField('mediaServerType', { mediaServerType: 'plex' }, 'Jellyfin or Emby');
expectField('baseUrl', { baseUrl: '' }, 'required');
expectField('baseUrl', { baseUrl: 'file:///etc/passwd' }, 'http and https');
expectField('publicUrl', { publicUrl: 'not-a-url' }, 'valid');
expectField('priority', { priority: '-1' }, 'between');
expectField('maxUsers', { maxUsers: '0' }, 'between');
expectField('apiKey', { apiKey: 'short' }, 'format');

const duplicate = safeAdminErrorInfo({ code: '23505', constraint: 'jellyfin_servers_slug_key' });
if (duplicate.field !== 'slug') throw new Error(`Duplicate slug should target slug, got ${duplicate.field}`);

const parsed = parseServerForm(valid, { apiKeyRequired: true });
if (parsed.slug !== 'primary-server' || parsed.baseUrl !== 'https://allowed.example' || parsed.mediaServerType !== 'jellyfin') {
    throw new Error('Valid Jellyfin server form did not normalize as expected');
}
const effectiveFallback = inactivity.serverPolicy({
    inactivity_policy: {},
    free_first_playback_grace_days: 5,
    free_playback_window_days: 14,
    free_minimum_playback_minutes: 60
}, { enabled: true, dryRun: false });
if (effectiveFallback.firstPlaybackGraceDays !== 5 || effectiveFallback.playbackWindowDays !== 14 || effectiveFallback.minimumPlaybackMinutes !== 60) {
    throw new Error('Legacy server thresholds must remain the compatibility fallback until the Free plan owns a complete policy');
}
if (effectiveFallback.thresholdOwner !== 'free_server_compat') throw new Error('Fallback ownership must be explicit');

const effectivePlanPolicy = inactivity.serverPolicy({
    inactivity_policy: { firstPlaybackGraceDays: 6, playbackWindowDays: 10, minimumPlaybackMinutes: 50 },
    free_first_playback_grace_days: 5,
    free_playback_window_days: 14,
    free_minimum_playback_minutes: 60
}, { enabled: true, dryRun: false });
if (effectivePlanPolicy.firstPlaybackGraceDays !== 6 || effectivePlanPolicy.playbackWindowDays !== 10 || effectivePlanPolicy.minimumPlaybackMinutes !== 50) {
    throw new Error('A complete Free plan policy must override legacy server thresholds');
}
if (effectivePlanPolicy.thresholdOwner !== 'free_plan') throw new Error('Configured thresholds must be plan-owned');
if (Object.prototype.hasOwnProperty.call(effectivePlanPolicy, 'noPlaybackDays')) throw new Error('Free inactivity policy must not expose a separate login/activity retention rule');

const root = path.join(__dirname, '..');
const inactivitySource = fs.readFileSync(path.join(root, 'src/automation/customer-inactivity.js'), 'utf8');
for (const column of ['js.free_first_playback_grace_days', 'js.free_playback_window_days', 'js.free_minimum_playback_minutes']) {
    if (!inactivitySource.includes(column)) throw new Error(`Inactivity candidate discovery must read ${column} from the assigned server`);
}
if (!inactivitySource.includes("fa.inactivity_policy->>'playbackWindowDays'") || !inactivitySource.includes('ELSE js.free_playback_window_days')) throw new Error('Rolling playback SQL must prefer the Free plan window while retaining the assigned-server fallback');
const migrationSource = fs.readFileSync(path.join(root, 'db/migrations/20260917220000_free_server_inactivity_policy.sql'), 'utf8');
for (const expected of ['DEFAULT 3', 'DEFAULT 7', 'DEFAULT 30']) {
    if (!migrationSource.includes(expected)) throw new Error(`Per-server inactivity migration is missing ${expected}`);
}
const formView = fs.readFileSync(path.join(root, 'views/admin/server-form.ejs'), 'utf8');
for (const field of ['freeFirstPlaybackGraceDays', 'freePlaybackWindowDays', 'freeMinimumPlaybackMinutes']) {
    if (formView.includes(`name="${field}"`)) throw new Error(`Server form must no longer expose plan-owned ${field}`);
}
if (!formView.includes('Customer capacity') || !formView.includes('Fallback placement category')) throw new Error('Server form must remain focused on physical capacity and fallback placement metadata');

const legacyDefault = parseServerForm({ ...valid, mediaServerType: undefined }, { apiKeyRequired: true });
if (legacyDefault.mediaServerType !== 'jellyfin') throw new Error('Missing media server type must remain backward-compatible with Jellyfin');

const emby = parseServerForm({ ...valid, name:'Emby', slug:'emby-server', mediaServerType:'emby', baseUrl:'https://emby.internal.example' }, { apiKeyRequired: true });
if (emby.mediaServerType !== 'emby' || emby.baseUrl !== 'https://emby.internal.example') throw new Error('Valid Emby server form did not normalize as expected');

const arbitraryHost = parseServerForm({ ...valid, baseUrl: 'https://new-jellyfin.example/' }, { apiKeyRequired: true });
if (arbitraryHost.baseUrl !== 'https://new-jellyfin.example') {
    throw new Error('Authenticated admin-added media-server host should be accepted without an env allowlist');
}

const masterSecret = '0123456789abcdef0123456789abcdef';
const serverA = '00000000-0000-0000-0000-000000000001';
const serverB = '00000000-0000-0000-0000-000000000002';
const tokenA = webhookAuth.deriveServerSecret(masterSecret, serverA);
const tokenB = webhookAuth.deriveServerSecret(masterSecret, serverB);
if (tokenA === tokenB || tokenA.length !== 64 || tokenB.length !== 64) throw new Error('Jellyfin webhook tokens must be deterministic 256-bit server-scoped values');
if (webhookToken.tokenFor(masterSecret, serverA) !== tokenA) throw new Error('The operator token helper must use the same canonical server-scoped derivation as webhook verification');
if (!webhookAuth.verifyServerSecret(tokenA, masterSecret, serverA).authenticated) throw new Error('A server-scoped webhook token must authenticate its own server');
if (webhookAuth.verifyServerSecret(tokenA, masterSecret, serverB).authenticated) throw new Error('A Jellyfin webhook token from server A must not authenticate server B');
if (webhookAuth.verifyServerSecret(masterSecret, masterSecret, serverA).authenticated) throw new Error('The shared master webhook secret must fail closed by default');
const legacy = webhookAuth.verifyServerSecret(masterSecret, masterSecret, serverA, { allowLegacy: true });
if (!legacy.authenticated || legacy.mode !== 'legacy') throw new Error('Explicit legacy webhook compatibility must remain available for controlled migration');

const webhookRoute = fs.readFileSync(path.join(__dirname, '..', 'src/platform/webhooks.js'), 'utf8');
if (!webhookRoute.includes('verifyServerSecret') || !webhookRoute.includes('JELLYFIN_WEBHOOK_ALLOW_LEGACY_SECRET')) throw new Error('Jellyfin webhook route must verify a server-scoped token and gate legacy compatibility explicitly');
if (webhookRoute.includes("sameSecret(req.get('x-fin-fusion-webhook-secret'),secret)")) throw new Error('Jellyfin webhook route must not authenticate every server with the raw shared secret');
if (!webhookRoute.includes("require('express-rate-limit')") || !webhookRoute.includes('jellyfinWebhookRateLimit,requestMaintenanceGuard')) throw new Error('Authenticated Jellyfin playback webhooks must be rate-limited before the handler runs');

console.log('Jellyfin/Emby server form validation, plan-owned Free inactivity fallback and playback webhook isolation smoke: ok');
