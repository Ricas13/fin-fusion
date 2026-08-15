'use strict';

const assert=require('assert');
const policy=require('../src/security/outbound-url-policy');

assert.strictEqual(policy.addressTrustedByCidrs('10.20.0.5',['10.20.0.0/24']),true,'Trusted IPv4 CIDR did not match');
assert.strictEqual(policy.addressTrustedByCidrs('10.21.0.5',['10.20.0.0/24']),false,'IPv4 address escaped trusted CIDR');
assert.strictEqual(policy.addressTrustedByCidrs('fd12:3456:789a::5',['fd12:3456:789a::/64']),true,'Trusted IPv6 CIDR did not match');
assert.strictEqual(policy.addressTrustedByCidrs('fd12:3456:789b::5',['fd12:3456:789a::/64']),false,'IPv6 address escaped trusted CIDR');
assert.strictEqual(policy.addressTrustedByCidrs('::ffff:10.20.0.5',['10.20.0.0/24']),true,'Dotted IPv4-mapped IPv6 did not use IPv4 trust policy');
assert.strictEqual(policy.addressTrustedByCidrs('::ffff:a14:5',['10.20.0.0/24']),true,'Hex IPv4-mapped IPv6 did not use IPv4 trust policy');
assert.strictEqual(policy.mappedIpv4('2001:db8::ffff:a9fe:a9fe'),null,'Non-mapped IPv6 suffix was mistaken for IPv4');
for(const address of ['169.254.169.254','::ffff:169.254.169.254','::ffff:a9fe:a9fe','0:0:0:0:0:ffff:a9fe:a9fe','fd00:ec2::254','fe80::1']){
  assert.strictEqual(policy.classify(address).hard,true,`${address} is not hard-blocked`);
}
console.log('Outbound destination policy smoke test passed.');
