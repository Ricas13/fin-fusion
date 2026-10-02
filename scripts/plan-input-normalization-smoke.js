'use strict';

const assert=require('assert');
const planInput=require('../src/catalog/plan-input');
const planContract=require('../src/catalog/plan-contract');

assert.strictEqual(planInput.bool(true),true);
assert.strictEqual(planInput.bool('on'),true);
assert.strictEqual(planInput.bool('1'),true);
assert.strictEqual(planInput.bool('yes'),true);
assert.strictEqual(planInput.bool('false'),false);
assert.strictEqual(planInput.bool(undefined),false);

assert.strictEqual(planInput.text('  hello  ',10),'hello');
assert.strictEqual(planInput.text('abcdefgh',4),'abcd');

assert.strictEqual(planInput.integer('0',0,50,'Streams'),0);
assert.strictEqual(planInput.integer('50',0,50,'Streams'),50);
assert.throws(()=>planInput.integer('1.5',0,50,'Streams'),/whole number from 0 to 50/);
assert.throws(()=>planInput.integer('01',0,50,'Streams'),/whole number from 0 to 50/);
assert.throws(()=>planInput.integer('51',0,50,'Streams'),/whole number from 0 to 50/);

assert.strictEqual(planInput.moneyMinor('0'),0);
assert.strictEqual(planInput.moneyMinor('6'),600);
assert.strictEqual(planInput.moneyMinor('6.5'),650);
assert.strictEqual(planInput.moneyMinor('6.50'),650);
assert.throws(()=>planInput.moneyMinor('-1'),/valid non-negative price/);
assert.throws(()=>planInput.moneyMinor('1.234'),/valid non-negative price/);
assert.throws(()=>planInput.moneyMinor('100000.01'),/between 0 and 100,000/);

assert.strictEqual(planInput.planCode('  PREMIUM-MONTHLY  '),'premium-monthly');
assert.throws(()=>planInput.planCode('x'),/2–50 characters/);
assert.throws(()=>planInput.planCode('bad_code'),/lowercase letters, numbers and hyphens/);

assert.deepStrictEqual(
  planInput.uniqueTextValues(' Movies, TV\nMovies ',{split:true}),
  ['Movies','TV']
);
assert.deepStrictEqual(
  planInput.uniqueTextValues(['one','two','one']),
  ['one','two']
);

assert.strictEqual(planInput.enumValue('month',['month','year'],'year'),'month');
assert.strictEqual(planInput.enumValue('week',['month','year'],'year'),'year');
assert.strictEqual(planInput.enumValue('premium',new Set(['premium','free']),'free'),'premium');
assert.strictEqual(planInput.enumValue('custom',new Set(['premium','free']),'free'),'free');

planContract.validateCreatePlan({
  code:'paid-jellyfin',
  name:'Paid Jellyfin',
  description:'',
  serviceType:'jellyfin',
  audience:'direct',
  billing:'month',
  duration:30,
  priceMinor:600,
  currency:'GBP',
  capacityLimit:50,
  serverClass:'premium',
  visible:true,
  active:true,
  jellyfinAccessModel:'concurrent_streams',
  jellyfinHouseholdNetworkLimit:1,
  jellyfinHouseholdLeaseMinutes:240,
  stremioHouseholdNetworkLimit:1,
  stremioHouseholdLeaseMinutes:240,
  streams:1,
  libraryMode:'all',
  libraries:[]
});
assert.throws(()=>planContract.validateCreatePlan({
  code:'paid-jellyfin',name:'Paid Jellyfin',description:'',serviceType:'jellyfin',audience:'direct',
  billing:'month',duration:30,priceMinor:600,currency:'GBP',capacityLimit:50,serverClass:'premium',
  visible:true,active:true,jellyfinAccessModel:'concurrent_streams',jellyfinHouseholdNetworkLimit:1,
  jellyfinHouseholdLeaseMinutes:240,stremioHouseholdNetworkLimit:1,stremioHouseholdLeaseMinutes:240,
  streams:99,libraryMode:'all',libraries:[]
}),/Concurrent streams/);

assert.deepStrictEqual(
  planContract.validateProviderMapping({provider:'stripe',mode:'payment',externalId:''}),
  {provider:'stripe',mode:'payment',externalId:null}
);
assert.throws(
  ()=>planContract.validateProviderMapping({provider:'stripe',mode:'subscription',externalId:''}),
  /require an external provider ID/
);

console.log('shared plan input and catalog contract smoke: ok');
