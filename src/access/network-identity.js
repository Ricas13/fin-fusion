'use strict';

const crypto = require('crypto');
const net = require('net');

function stripPort(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end > 0) return raw.slice(1, end);
  }
  const ipv4Port = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4Port) return ipv4Port[1];
  if (raw.startsWith('::ffff:') && net.isIP(raw.slice(7)) === 4) return raw.slice(7);
  return raw;
}

function expandIpv6(address) {
  const raw = String(address || '').toLowerCase();
  if (!raw || net.isIP(raw) !== 6) return null;
  let source = raw;
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const a = ((parts[0] << 8) | parts[1]).toString(16);
    const b = ((parts[2] << 8) | parts[3]).toString(16);
    source = `${source.slice(0, lastColon)}:${a}:${b}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => group.padStart(4, '0'));
}

function canonicalNetwork(value) {
  const address = stripPort(value);
  const version = net.isIP(address);
  if (version === 4) return `ipv4:${address}`;
  if (version === 6) {
    const groups = expandIpv6(address);
    if (!groups) return null;
    return `ipv6:${groups.slice(0, 4).join(':')}::/64`;
  }
  return null;
}

function hashSecret() {
  const explicit = String(process.env.HOUSEHOLD_NETWORK_HASH_KEY || '').trim();
  if (explicit) {
    if (explicit.length < 32) throw new Error('HOUSEHOLD_NETWORK_HASH_KEY must provide at least 32 characters.');
    return explicit;
  }
  const sharedRoot = String(process.env.JELLYFIN_ENCRYPTION_KEY || process.env.SESSION_SECRET || '').trim();
  if (sharedRoot.length < 32) throw new Error('JELLYFIN_ENCRYPTION_KEY, SESSION_SECRET, or HOUSEHOLD_NETWORK_HASH_KEY must provide at least 32 characters for household network hashing.');
  return crypto.createHmac('sha256', sharedRoot).update('captainfin:household-network:v1').digest('hex');
}

function hashNetwork(value, options = {}) {
  const canonical = canonicalNetwork(value);
  if (!canonical) return null;
  const secret = String(options.secret || hashSecret());
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function requestAddress(req) {
  return stripPort(req?.ip || req?.socket?.remoteAddress || '');
}

module.exports = { stripPort, expandIpv6, canonicalNetwork, hashSecret, hashNetwork, requestAddress };
