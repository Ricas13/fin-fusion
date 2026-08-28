'use strict';

const assert=require('assert');
const fs=require('fs');
const communications=require('../src/platform/customer-communications');

const source=fs.readFileSync('src/platform/customer-communications.js','utf8');
const view=fs.readFileSync('views/customer/communications.ejs','utf8');

assert.match(source,/async function safeOptional\(/,'communications page must isolate optional subsystem failures');
assert.match(source,/safeOptional\('delivery status'/,'delivery status must degrade independently');
assert.match(source,/safeOptional\('notification event catalogue'/,'event catalogue must degrade independently');
assert.match(source,/safeOptional\('customer event preferences'/,'customer event preferences must degrade independently');
assert.match(source,/safeOptional\('preferred currency'/,'preferred currency must degrade independently');
assert.match(source,/safeOptional\('enabled currencies'/,'enabled currencies must degrade independently');
assert.doesNotMatch(source,/Promise\.all\(\[prefs\(req\.session\.customerId\).*allowedEvents/s,'optional communications lookups must not share one fail-all Promise.all');
assert.match(source,/const row=await prefs\(req\.session\.customerId\)/,'core communications preference lookup must remain required');
assert.match(source,/Customer communications \$\{label\} unavailable:/,'degraded optional lookups must identify themselves in server logs');

assert.deepStrictEqual(communications.deliveryChannels({
    telegramEnabled:true,
    telegramConfigured:true,
    discordEnabled:true,
    discordConfigured:false,
    whatsappEnabled:false,
    whatsappConfigured:true
}),['telegram'],'only globally enabled and configured channels may be visible to customers');
assert.deepStrictEqual(communications.deliveryChannels({
    telegramEnabled:true,
    telegramConfigured:true,
    discordEnabled:true,
    discordConfigured:true,
    whatsappEnabled:true,
    whatsappConfigured:true
}),['telegram','discord','whatsapp'],'all ready channels should remain available');
assert.deepStrictEqual(communications.deliveryChannels({}),[],'missing delivery configuration must expose no optional channel cards');
assert(!view.includes("'Unavailable'")&&!view.includes('>Unavailable<'),'customer communications must not render unavailable channel cards');
assert(view.includes("channels.includes('telegram')")&&view.includes("channels.includes('discord')")&&view.includes("channels.includes('whatsapp')"),'channel cards must be gated by the shared visible-channel list');
assert(view.includes('channels.forEach(function(channel)'),'event columns must use the same visible-channel list as cards');

console.log('customer communications page resilience smoke passed');
