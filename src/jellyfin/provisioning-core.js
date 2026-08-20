'use strict';

// Historical import path. All public provisioning calls must pass through the
// canonical facade so entitlement holds, expiry, password setup and downgrade
// behavior cannot be bypassed by an old import.
module.exports=require('./provisioning');
