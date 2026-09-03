'use strict';

const crypto = require('crypto');
const net = require('net');

// Cloudflare's published origin-facing proxy ranges. Keep this list in sync with
// https://www.cloudflare.com/ips/. These are used only to decide whether a
// Cloudflare visitor-IP header is trustworthy; arbitrary clients cannot opt in
// by sending CF-Connecting-IP themselves.
const CLOUDFLARE_CIDRS = Object.freeze([
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
]);

// Household identity must represent an internet-facing client network, never a
// loopback/private reverse proxy, documentation address, or other non-routable
// hop. Treating a shared proxy address as the household identity collapses every
// customer request onto the same lease and silently defeats the household limit.
const NON_PUBLIC_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32'
]);

function blockList(cidrs) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [address, prefixRaw] = cidr.split('/');
    const family = net.isIP(address);
    list.addSubnet(address, Number(prefixRaw), family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

const cloudflareProxies = blockList(CLOUDFLARE_CIDRS);
const nonPublicAddresses = blockList(NON_PUBLIC_CIDRS);

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

function networkDescriptor(value) {
  const canonical = canonicalNetwork(value);
  if (!canonical) return null;
  return {
    canonical,
    family: canonical.startsWith('ipv4:') ? 'ipv4' : 'ipv6'
  };
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
  const descriptor = networkDescriptor(value);
  if (!descriptor) return null;
  const secret = String(options.secret || hashSecret());
  return crypto.createHmac('sha256', secret).update(descriptor.canonical).digest('hex');
}

function isCloudflareAddress(value) {
  const address = stripPort(value);
  const family = net.isIP(address);
  if (!family) return false;
  return cloudflareProxies.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isPublicAddress(value) {
  const address = stripPort(value);
  const family = net.isIP(address);
  if (!family) return false;
  return !nonPublicAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function requestHeader(req, name) {
  const direct = req?.headers?.[name];
  if (Array.isArray(direct)) return direct.length === 1 ? String(direct[0] || '') : '';
  return String(direct || '');
}

function forwardedAddresses(req) {
  const raw = requestHeader(req, 'x-forwarded-for');
  if (!raw) return [];
  return raw
    .split(',')
    .map(value => stripPort(value))
    .filter(value => net.isIP(value));
}

function cloudflareVisitorHeader(req) {
  // If Pseudo IPv4 is configured to overwrite headers, Cloudflare preserves the
  // real IPv6 visitor in CF-Connecting-IPv6. Prefer it so the existing /64
  // household normalization continues to represent the real IPv6 network.
  const connectingIpv6 = stripPort(requestHeader(req, 'cf-connecting-ipv6'));
  if (net.isIP(connectingIpv6) === 6 && isPublicAddress(connectingIpv6) && !isCloudflareAddress(connectingIpv6)) return connectingIpv6;

  const connectingIp = stripPort(requestHeader(req, 'cf-connecting-ip'));
  if (net.isIP(connectingIp) && isPublicAddress(connectingIp) && !isCloudflareAddress(connectingIp)) return connectingIp;
  return '';
}

function forwardedVisitorAddress(addresses) {
  // Walk from the origin-facing side of X-Forwarded-For toward the visitor.
  // This selects the nearest public non-Cloudflare hop and avoids trusting an
  // arbitrary left-most value that a client may have supplied before Cloudflare.
  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index];
    if (!isPublicAddress(address) || isCloudflareAddress(address)) continue;
    return address;
  }
  return '';
}

function requestAddress(req) {
  // req.ip is the primary Express trust boundary. When the configured reverse
  // proxy chain has already resolved a public visitor address, use it directly.
  const effectiveAddress = stripPort(req?.ip || req?.socket?.remoteAddress || '');
  if (isPublicAddress(effectiveAddress) && !isCloudflareAddress(effectiveAddress)) return effectiveAddress;

  // Cloudflare's visitor-IP headers are authoritative only when Express itself
  // resolved the effective client hop to a published Cloudflare edge. Merely
  // finding a Cloudflare-looking value somewhere in X-Forwarded-For is not a
  // sufficient trust signal: an untrusted client or internal caller can supply
  // that header. If the reverse-proxy trust chain is misconfigured, fail closed
  // instead of letting a header opt itself into Cloudflare trust.
  if (!isCloudflareAddress(effectiveAddress)) return '';

  const headerVisitor = cloudflareVisitorHeader(req);
  if (headerVisitor) return headerVisitor;

  // CF-Connecting-IP should normally be present, but X-Forwarded-For gives us a
  // fallback when an intermediate trusted proxy drops that header. This fallback
  // is reached only after the effective client hop has independently been proven
  // to be Cloudflare.
  const forwardedVisitor = forwardedVisitorAddress(forwardedAddresses(req));
  if (forwardedVisitor) return forwardedVisitor;

  // A Cloudflare edge address is not a customer household. Failing closed here
  // is preferable to refreshing one shared lease for every visitor.
  return '';
}

module.exports = {
  CLOUDFLARE_CIDRS,
  NON_PUBLIC_CIDRS,
  stripPort,
  expandIpv6,
  canonicalNetwork,
  networkDescriptor,
  hashSecret,
  hashNetwork,
  isCloudflareAddress,
  isPublicAddress,
  forwardedAddresses,
  forwardedVisitorAddress,
  requestAddress
};
