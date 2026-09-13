'use strict';

const assert=require('assert');
const fs=require('fs');

const compact=fs.readFileSync('src/platform/customer-360-compact.js','utf8');
const individual=fs.readFileSync('src/platform/admin-customer-individual-actions.js','utf8');
const lifecycle=fs.readFileSync('src/platform/admin-customer-direct-lifecycle.js','utf8');
const composition=fs.readFileSync('src/platform/admin-route-composition.js','utf8');

assert(!compact.includes('/admin/customers/bulk/preview'),'Customer 360 must not submit through the bulk preview route');
assert(!compact.includes('bulkForm('),'Customer 360 must not retain the single-customer-to-bulk helper');
assert(!individual.includes("router.post('/admin/customers/bulk/preview'"),'individual action router must not shadow the real bulk preview route');
assert(compact.includes("customerLink(id,'change-plan'"),'Customer 360 plan changes must use the direct customer route');
assert(compact.includes("customerLink(id,'move-server'"),'Customer 360 server moves must use the direct customer route');
assert(compact.includes("customerLink(id,'delete-customer'"),'Customer 360 permanent deletion must use the direct customer route');
assert(compact.includes("customerLink(id,'subscriptions/revoke'"),'Customer 360 plan revocation must use the targeted subscription workflow');
assert(lifecycle.includes("forceMove.move(req.params.customerId,serverId"),'direct server move must use the canonical admin force-move service');
assert(lifecycle.includes('deletion.hardDeletePortalCustomer'),'direct permanent deletion must use the canonical deletion saga');
assert(lifecycle.includes('ownerStatus(req.session.authUserId)'),'direct permanent deletion must preserve the owner-only guard');
assert(lifecycle.includes('subscriptionForCustomer'),'direct plan changes must bind to an explicit customer-owned subscription');
assert(composition.includes('createAdminCustomerDirectLifecycleRouter'),'direct lifecycle router must be mounted');

console.log('customer 360 direct action smoke: ok');
