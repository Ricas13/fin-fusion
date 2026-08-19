'use strict';

const assert = require('assert');
const { renderProfessionalEmail, firstUrl } = require('../src/integrations/email-template');

const text = 'Your subscription is now active.\n\nManage your account here:\nhttps://portal.example.test/account';
const html = renderProfessionalEmail({
    eventType: 'subscription.activated',
    subject: 'Your CAPTAiNFiN subscription is active',
    text,
    siteName: 'CAPTAiNFiN',
    publicBaseUrl: 'https://portal.example.test'
});

assert(html.startsWith('<!doctype html>'));
assert(html.includes('CAPTAiNFiN'));
assert(html.includes('Subscription active'));
assert(html.includes('Your CAPTAiNFiN subscription is active'));
assert(html.includes('Open CAPTAiNFiN'));
assert(html.includes('https://portal.example.test/account'));
assert(html.includes('automated service message'));
assert(!html.includes('<script'));
assert.strictEqual(firstUrl(text), 'https://portal.example.test/account');

const escaped = renderProfessionalEmail({
    eventType: 'payment.received',
    subject: '<Payment & receipt>',
    text: '<unsafe> & text',
    siteName: 'CAPTAiNFiN'
});
assert(escaped.includes('&lt;Payment &amp; receipt&gt;'));
assert(escaped.includes('&lt;unsafe&gt; &amp; text'));
assert(!escaped.includes('<unsafe>'));

console.log('email-template-smoke: ok');
