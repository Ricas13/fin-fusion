'use strict';

const assert = require('assert');
const networkIdentity = require('../src/access/network-identity');

assert.strictEqual(networkIdentity.isCloudflareAddress('172.64.10.5'), true, 'Cloudflare IPv4 must be recognized');
assert.strictEqual(networkIdentity.isCloudflareAddress('104.16.9.8'), true, 'Cloudflare IPv4 ranges must be recognized');
assert.strictEqual(networkIdentity.isCloudflareAddress('2606:4700::1234'), true, 'Cloudflare IPv6 must be recognized');
assert.strictEqual(networkIdentity.isCloudflareAddress('81.2.69.142'), false, 'ordinary client IPs must not be trusted as Cloudflare');

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
    ip: '81.2.69.142',
    headers: { 'cf-connecting-ip': '203.0.113.99' },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '81.2.69.142',
  'a direct client must not be able to spoof CF-Connecting-IP'
);

assert.strictEqual(
  networkIdentity.requestAddress({
    ip: '2606:4700::1234',
    headers: {
      'cf-connecting-ip': '240.16.0.1',
      'cf-connecting-ipv6': '2001:db8:abcd:1234:1111:2222:3333:4444'
    },
    socket: { remoteAddress: '172.18.0.2' }
  }),
  '2001:db8:abcd:1234:1111:2222:3333:4444',
  'Cloudflare Pseudo IPv4 overwrite mode must preserve the real visitor IPv6'
);

assert.strictEqual(
  networkIdentity.canonicalNetwork('2001:db8:abcd:1234:1111:2222:3333:4444'),
  'ipv6:2001:0db8:abcd:1234::/64',
  'restored IPv6 visitors must retain household /64 normalization'
);

console.log('cloudflare network identity smoke: ok');
