'use strict';

// Canonical implementation. Kept at the historical module path so workers,
// admin pages and customer portal callers all consume the same entitlement
// definition without a compatibility fork.
module.exports=require('./request-user-sync-v2');
