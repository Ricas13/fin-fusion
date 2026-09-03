'use strict';

const assert = require('assert');
const networkIdentity = require('../src/access/network-identity');

assert.strictEqual(networkIdentity.isCloudflareAddress('172.64.10.5'), true, 'Cloudflare IPv4 must be recognized');
assert.strictEqual(networkIdentity.isCloudflareAddress('104.16.9.8'), true, 'Cloudflare IPv4 ranges must be recognized');
assert.strictEqual(networkIdentity.isCloudflareAddress('2606:4700::1234'), true, 'Cloudflare IPv6 must be recognized');
assert.strictEqual(networkIdentity.isCloudflareAddress('81.2.69.142'), false, 'ordinary client IPs must not be trusted as Cloudflare');
assert.strictEqual(networkIdentity.isPublicAddress('81.2.69.142'), true, 'ordinary public visitor addresses must be usable as household identities');
assert.strictEqual(networkIdentity.isPublicAddress('172.18.0.2'), false, 'Docker/reverse-proxy addresses must never become household identities');
assert.strictEqual(networkIdentity.isPublicAddress('127.0.0.1'), false, 'loopback addresses must never become household identities');

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '172.64.10.5',
    headers: { 'cf-connecting-ip': '81.2.69.142' },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '81.2.69.142',
  'a genuine Cloudflare edge must restore the visitor IPv4 address'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '172.64.10.5',
    headers: { 'x-forwarded-for': '81.2.69.142, 172.64.10.5' },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '81.2.69.142',
  'X-Forwarded-For may recover the visitor after the effective client hop is independently proven to be Cloudflare'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '172.18.0.2',
    headers: {
      'cf-connecting-ip': '81.2.69.142',
      'x-forwarded-for': '81.2.69.142, 172.64.10.5'
    },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '',
  'a local reverse proxy must fail closed when Express did not independently resolve the effective hop to Cloudflare'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '172.18.0.2',
    headers: { 'cf-connecting-ip': '81.2.69.142' },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '',
  'a private proxy address without a proven Cloudflare hop must fail closed instead of trusting a spoofable header'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '172.64.10.5',
    headers: {},
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '',
  'a Cloudflare edge without a recoverable visitor must never become the shared household identity'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '81.2.69.142',
    headers: {
      'cf-connecting-ip': '8.8.8.8',
      'x-forwarded-for': '8.8.8.8, 172.64.10.5'
    },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '81.2.69.142',
  'a directly resolved client must not be able to spoof Cloudflare visitor headers'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '2606:4700::1234',
    headers: {
      'cf-connecting-ip': '240.16.0.1',
      'cf-connecting-ipv6': '2a00:1450:4009:81b::200e'
    },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '2a00:1450:4009:81b::200e',
  'Cloudflare Pseudo IPv4 overwrite mode must preserve the real visitor IPv6'
);

assert.strictEqual(
  networkIdentity.canonicalNetwork('2a00:1450:4009:81b:1111:2222:3333:4444'),
  'ipv6:2a00:1450:4009:081b::/64',
  'restored IPv6 visitors must retain household /64 normalization'
);

console.log('cloudflare network identity smoke: ok');
