'use strict';

const assert=require('assert');
const {customerIdentity}=require('../src/platform/customer-list-identity');

assert.deepStrictEqual(
    customerIdentity({display_name:'Jane Smith',login_username:'jsmith',jellyfin_username:'JaneJellyfin',email:'jane@example.com'}),
    {primary:'Jane Smith',secondary:'jane@example.com'},
    'display name must remain the preferred customer identity'
);
assert.deepStrictEqual(
    customerIdentity({login_username:'jsmith',jellyfin_username:'JaneJellyfin',email:'jane@example.com'}),
    {primary:'jsmith',secondary:'jane@example.com'},
    'portal username must be used when no display name exists'
);
assert.deepStrictEqual(
    customerIdentity({jellyfin_username:'JaneJellyfin',email:'jane@example.com'}),
    {primary:'JaneJellyfin',secondary:'jane@example.com'},
    'Jellyfin username must be used before falling back to email'
);
assert.deepStrictEqual(
    customerIdentity({jellyfin_username:'jane@example.com',email:'jane@example.com'}),
    {primary:'jane@example.com',secondary:''},
    'the same email must not be rendered twice'
);
assert.deepStrictEqual(
    customerIdentity({login_username:'JANE@EXAMPLE.COM',email:'jane@example.com'}),
    {primary:'JANE@EXAMPLE.COM',secondary:''},
    'duplicate identity suppression must be case-insensitive'
);
assert.deepStrictEqual(
    customerIdentity({email:'jane@example.com'}),
    {primary:'jane@example.com',secondary:''},
    'email must be a useful final identity instead of the generic Customer label'
);
assert.deepStrictEqual(customerIdentity({}),{primary:'Customer',secondary:''},'generic Customer is only the last-resort fallback');

console.log('customer list identity smoke: ok');
