'use strict';

process.env.NODE_ENV = 'production';
delete process.env.JELLYFIN_ALLOWED_HOSTS;

const { parseServerForm, safeAdminErrorInfo } = require('../src/platform/admin-servers');

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

const legacyDefault = parseServerForm({ ...valid, mediaServerType: undefined }, { apiKeyRequired: true });
if (legacyDefault.mediaServerType !== 'jellyfin') throw new Error('Missing media server type must remain backward-compatible with Jellyfin');

const emby = parseServerForm({ ...valid, name:'Emby', slug:'emby-server', mediaServerType:'emby', baseUrl:'https://emby.internal.example' }, { apiKeyRequired: true });
if (emby.mediaServerType !== 'emby' || emby.baseUrl !== 'https://emby.internal.example') throw new Error('Valid Emby server form did not normalize as expected');

const arbitraryHost = parseServerForm({ ...valid, baseUrl: 'https://new-jellyfin.example/' }, { apiKeyRequired: true });
if (arbitraryHost.baseUrl !== 'https://new-jellyfin.example') {
    throw new Error('Authenticated admin-added media-server host should be accepted without an env allowlist');
}

console.log('Jellyfin/Emby server form validation smoke: ok');
