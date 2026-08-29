'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'src/stremio/runtime.js'), 'utf8');
const household = fs.readFileSync(path.join(root, 'src/stremio/household-access.js'), 'utf8');

assert(runtime.includes("kind: 'subscription_ended'"), 'a recognized but inactive Stremio install token must be distinguishable from an invalid token');
assert(runtime.includes("name: 'CAPTAiNFiN • Subscription ended'"), 'ended subscriptions must return a visible fake Stremio stream result');
assert(runtime.includes("title: 'Subscription ended'"), 'subscription-ended result must carry an explicit title');
assert(runtime.includes('Renew your subscription in your CAPTAiNFiN account to restore streams.'), 'subscription-ended result must tell the customer how to recover access');
assert(runtime.includes('notWebReady: false'), 'subscription-ended fake result must remain visible to Stremio Web');
assert(runtime.includes("state.kind === 'subscription_ended'"), 'stream route must return the fake result before source resolution for ended subscriptions');
assert(runtime.includes("'/stremio/:token/subscription-ended/:type/:videoId.mp4'"), 'subscription-ended result must have a stable local HTTPS media target');
assert(runtime.includes('const state = await installTokenState(req.params.token);') && runtime.includes('await entitlements.markUse(state.entitlement.id, \'manifest\')'), 'recognized ended install tokens must keep serving the addon manifest so Stremio can surface the error result');

assert(household.includes('function deniedStream('), 'household-limit failure must keep returning a fake Stremio stream result');
assert(household.includes("return 'Household IP limit reached';"), 'household-limit fake result must name the actual access error');
assert(household.includes('CAPTAiNFiN • ${title}'), 'household-limit fake result must remain visibly branded');
assert(household.includes('already reached its allowed household internet connections'), 'household-limit result must explain that the plan allowance is exhausted');

console.log('stremio access error smoke: ok');
