'use strict';

const assert=require('assert');
const fs=require('fs');

const grace=fs.readFileSync('src/entitlements/jellyfin-inactivity-grace.js','utf8');
const forceAccess=fs.readFileSync('src/platform/admin-customer-force-access.js','utf8');
const permanent=fs.readFileSync('src/entitlements/permanent-access.js','utf8');
const inactivity=fs.readFileSync('src/automation/customer-inactivity-scoped.js','utf8');

assert(forceAccess.includes('permanentAccess.revoke(customerId'), 'Return to plan rules must revoke the permanent-access override.');
assert(permanent.includes('revoked_at=NOW()'), 'Permanent-access revoke must persist the moment automation resumes.');
assert(grace.includes('customer_entitlement_overrides'), 'Inactivity grace must inspect the durable permanent-access transition.');
assert(grace.includes('permanent_access=FALSE')&&grace.includes('revoked_at IS NOT NULL'), 'Inactivity grace must require a completed return-to-automation transition.');
assert(grace.includes("source: 'automation_resume'"), 'Inactivity grace must identify return-to-automation as a grace source.');
assert(grace.includes('laterGraceReference'), 'The newest restore or automation-resume event must own the observation window.');
assert(inactivity.includes('restorationGrace.applyRestorationGrace'), 'Free Server enforcement must apply restoration/resume grace before removal.');

console.log('return-to-automation inactivity grace smoke: ok');
