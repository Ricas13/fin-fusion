'use strict';
const assert=require('assert');
const checkout=require('../src/platform/flexible-checkout');

// The production audit must not turn intentionally supported prepaid top-ups
// into a checkout error. One-time purchases are serialized/stacked by the
// subscription database lifecycle; only overlapping provider recurring
// agreements are intercepted by the checkout layer.
assert.equal(typeof checkout.overlappingRecurring,'function');
assert.equal(Object.prototype.hasOwnProperty.call(checkout,'overlappingPaidRows'),false,'checkout must not export or apply a blanket paid-overlap rejection that would break prepaid stacking');
console.log('audit prepaid stacking contract smoke: ok');
