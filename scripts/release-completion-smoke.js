'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

function read(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}
function has(source,fragment,message){assert(source.includes(fragment),message||`Expected ${fragment}`);}
function lacks(source,fragment,message){assert(!source.includes(fragment),message||`Did not expect ${fragment}`);}

const customerDashboard=read('views/customer/dashboard.ejs');
const customerNav=read('views/customer/_nav.ejs');
has(customerNav,'href="/account/docs"','customer Help guide must always be available');
has(customerNav,'>Help</a>','customer Help guide label must remain distinct');
has(customerNav,'href="/account/support"','customer Support must remain a separate destination from Help');
lacks(customerNav,'Help &amp; support','customer Help guide and Support must not collapse back into one ambiguous tab');
has(customerDashboard,'Everything you have, in one place.','customer Home must summarize simultaneous active access');
has(customerDashboard,'provisioningState&&provisioningState.last_error','pending Jellyfin setup must surface the provisioning reason');
has(customerDashboard,'Retry setup','pending Jellyfin setup must expose a retry action');
has(customerDashboard,'without giving up your Free Server access','paid and Stremio changes must preserve simultaneous Free Server access');
lacks(customerDashboard,'Your Free Access entitlement is active, but Jellyfin provisioning has not completed yet.','pending setup copy must not incorrectly label paid users as Free Access');

const adminPassword=read('src/platform/admin-customer-jellyfin-password.js');
has(adminPassword,"router.get('/admin/customer-jellyfin-password'",'admin Jellyfin password support page must be mounted');
has(adminPassword,'provisioning.setJellyfinPassword(req.params.customerId,req.params.accountId,password)','admin support must use canonical Jellyfin password setter');
has(adminPassword,"'admin.customer.jellyfin_password.change'",'admin-assisted password changes must be audited');
lacks(adminPassword,'JSON.stringify({password','password must never be placed in audit metadata');
const adminRouter=read('src/platform/router.js');
has(adminRouter,'createAdminCustomerJellyfinPasswordRouter','admin password support router must be part of the live platform router');
const adminNav=read('src/platform/admin-nav.js');
has(adminNav,"'customer-jellyfin-password':Object.freeze({groupKey:'people',parentKey:'users'",'admin password support must remain discoverable from the customer workflow without becoming permanent People navigation');
lacks(adminNav,"['customer-jellyfin-password','Jellyfin Passwords','/admin/customer-jellyfin-password']",'Jellyfin password support must not return as a permanent People sidebar item');

const paymentReturn=read('src/platform/customer-payment-return.js');
has(paymentReturn,"/account?welcome=1&message=",'successful payment returns must enter the access welcome flow');
has(paymentReturn,"r.get('/account/stripe/return',paymentReturnLimit,requireCustomer,stripeReturnHandler)",'Stripe completion must use the authenticated confirmed-return handler');
has(paymentReturn,"intents.verify({intentId,nonce:state,providerCheckoutId:sessionId,scope:'customer',provider:'stripe',ownerId:req.session.customerId})",'Stripe return must verify the exact local checkout intent, session and customer before reporting success');
has(paymentReturn,"stripe.confirmCheckout(sessionId,row)",'Stripe return must confirm provider state before reporting payment success');
const checkout=read('src/platform/flexible-checkout.js');
lacks(checkout,"/account?welcome=1&message=Payment%20received.",'Stripe checkout creation must not optimistically report success before the provider return is verified');
const activation=read('src/platform/account-activation-router.js');
has(activation,"'/account?welcome=1'",'customer activation must carry the user into the access welcome flow');

const servers=read('src/platform/admin-servers.js');
has(servers,'Enable private integrations and add this Jellyfin hostname or network CIDR','private-address connection failures must explain how to resolve outbound trust');
has(servers,'Jellyfin hostname could not be resolved','DNS failures must be actionable');
has(servers,'connection was refused','connection-refused failures must be actionable');

const firstRun=read('views/auth/first-run-claim.ejs');
has(firstRun,'docker compose exec app npm run setup:claim','first-run setup must show a direct setup-code retrieval command');
has(firstRun,'You do not need to search application logs.','first-run setup must not require log archaeology');

// Repository hygiene is part of release integrity: old migration tools must be
// visibly legacy/fail-closed, and automated branch pruning must only delete
// refs whose complete history is already contained in main.
const packageJson=JSON.parse(read('package.json'));
assert.strictEqual(packageJson.private,true,'CAPTAiNFiN must remain a private npm package');
assert.strictEqual(packageJson.scripts['legacy:import-json'],'node scripts/migrate-json-to-postgres.js','legacy JSON import must be visibly namespaced as legacy tooling');
assert(!Object.prototype.hasOwnProperty.call(packageJson.scripts,'db:import-json'),'legacy JSON import must not look like an ordinary production database command');

const legacyImporter=read('scripts/migrate-json-to-postgres.js');
has(legacyImporter,"const CONFIRM_FLAG = '--confirm-legacy-migration'",'legacy JSON import must require explicit operator confirmation');
has(legacyImporter,"const NONEMPTY_OVERRIDE_FLAG = '--allow-nonempty-target'",'non-empty legacy import must require a separate dangerous override');
has(legacyImporter,'(SELECT COUNT(*)::int FROM customers) AS customers','legacy importer must inspect existing customers before writing');
has(legacyImporter,'(SELECT COUNT(*)::int FROM subscriptions) AS subscriptions','legacy importer must inspect existing subscriptions before writing');
has(legacyImporter,'(SELECT COUNT(*)::int FROM jellyfin_accounts) AS jellyfin_accounts','legacy importer must inspect existing Jellyfin accounts before writing');
has(legacyImporter,'Refusing legacy JSON import into a non-empty target','legacy importer must fail closed on a populated destination');

const branchHygiene=read('.github/workflows/branch-hygiene.yml');
has(branchHygiene,'contents: write','branch hygiene needs only repository-content write permission');
has(branchHygiene,'git merge-base --is-ancestor "origin/$branch" origin/main','branch pruning must prove each branch tip is contained in main');
has(branchHygiene,'git push origin --delete "$branch"','fully merged branches must be pruned');
has(branchHygiene,'Keeping branch with commits not contained in main','branches with unique commits must be retained');
has(branchHygiene,'if [[ "$branch" == "main" || "$branch" == "HEAD" ]]','main must be excluded explicitly from pruning');

const readme=read('README.md');
has(readme,'# CAPTAiNFiN','README must use the canonical public product name');
has(readme,'| Plisio | Yes | No | No |','README must document Plisio as one-time-only crypto checkout');
has(readme,'These `steam-fusion` / `steamfusion` names are **compatibility identifiers**','README must distinguish persistent compatibility identifiers from public branding');

console.log('release completion smoke: ok');
