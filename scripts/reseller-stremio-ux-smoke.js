'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const monthly=read('src/resellers/monthly.js');
const ux=read('src/platform/reseller-service-aware-portal.js');
const business=read('src/platform/reseller-business.js');
const client=read('public/js/reseller-service-aware.js');

assert(/productReadiness=require\('\.\.\/platform\/product-readiness'\)/.test(monthly),'reseller domain must import canonical product readiness');
assert(/productReadiness\.evaluate\(plan,readinessCtx\)/.test(monthly),'reseller domain must evaluate delivery readiness before sale');
assert(/owner&&delivery!==['"]jellyfin['"]/.test(monthly),'reseller owner delivery must remain Jellyfin-only');
assert(/portalReady=false/.test(monthly)&&/require a CAPTaINFiN portal activation/.test(monthly),'new Stremio reseller customers must require portal readiness in the domain');
assert(/!customer\.user_id/.test(monthly)&&/portal identity before switching/.test(monthly),'existing Stremio reseller customers must own a portal identity');
assert(/service_type_snapshot/.test(monthly)&&/account_purpose<>'stremio_internal'/.test(monthly),'reseller customer list must be service-aware and hide internal playback identities');
assert(/portalReady:portalIntent\.wantsPortal/.test(ux),'service-aware create route must explicitly carry portal readiness into the domain');
assert(/data-reseller-plan/.test(ux)&&/data-service-type/.test(ux),'reseller plan options must expose delivery metadata to the browser');
assert(/Create customer & deliver access/.test(ux),'generic reseller create action must not claim Jellyfin-only provisioning');
assert(/Stremio · portal managed/.test(ux),'Stremio-only customers must not be presented with normal Jellyfin credentials');
assert(/service==='stremio'/.test(ux)&&/private installation/.test(ux),'Stremio create success must explain portal-managed installation rather than Jellyfin provisioning');
assert(/reseller-service-aware\.js/.test(ux),'reseller pages must load the external CSP-safe service-aware helper');
assert(/needsPortal/.test(client)&&/checkbox\.checked=true/.test(client)&&/email\.required/.test(client),'browser helper must force portal activation fields for Stremio/bundle choices');
assert(/createResellerServiceAwarePortalRouter/.test(business),'service-aware reseller router must be mounted before legacy reseller routes');
assert(/reseller-service-sale/.test(ux),'service-aware reseller mutations must have persistent route rate limiting');

console.log('reseller Stremio UX smoke: ok');
