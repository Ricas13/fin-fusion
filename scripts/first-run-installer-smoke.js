'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const controller=read('src/auth/first-run-controller.js');
const setupCore=read('src/auth/first-run-setup.js');
const claimView=read('views/auth/first-run-claim.ejs');
const setupView=read('views/auth/first-run-setup.ejs');
const application=read('src/application.js');
const browserWorkflow=read('.github/workflows/browser.yml');

assert(claimView.includes('Verify this installation')&&claimView.includes('Why this is required'),'first-run claim UI must explain installation verification in plain language');
assert(claimView.includes('docker compose exec app npm run setup:claim'),'installer must show the normal claim-code command');
assert(claimView.includes('docker compose run --rm app npm run setup:claim'),'installer must retain the stopped-container fallback command');
assert(claimView.includes('permanently locks after the first administrator is created'),'installer must explain the one-time security boundary');
assert(!claimView.includes('3 · Dashboard')&&!setupView.includes('3 · Dashboard'),'installer must not imply the dashboard is part of first-run security setup');

assert(setupView.includes('Create the first administrator'),'administrator creation remains the second secure setup stage');
assert(setupView.includes('Jellyfin, Stremio, plans, payments, email and storefront features can all be configured afterwards'),'non-identity services must remain explicitly optional');
assert(setupView.includes('Create administrator & continue setup'),'completion action must describe the guided handoff');
assert(setupView.includes('What happens next?')&&setupView.includes('guided Setup page'),'installer must explain where the operator lands next');

assert(controller.includes("runtimeSettings.siteName() || 'CAPTAiNFiN'"),'first-run site-name fallback must use the canonical product display name');
assert(controller.includes("return res.redirect('/admin/setup')"),'successful first-run setup must hand off to guided admin Setup');
assert(controller.includes("req.session?.authRole === 'admin' ? '/admin/setup' : '/login'"),'locked first-run endpoint must return signed-in admins to guided Setup');

assert(setupCore.includes("crypto.createHmac('sha256'"),'claim code must remain HMAC protected');
assert(setupCore.includes('crypto.timingSafeEqual'),'claim verification must remain timing-safe');
assert(setupCore.includes('delete installation.firstRunClaimHash'),'claim material must still be destroyed after administrator creation');
assert(controller.includes('await regenerate(req)'),'successful claim verification must still regenerate the browser session');
assert(controller.includes('30 * 60 * 1000'),'first-run authorization must remain time limited');

assert(application.includes("console.log('CAPTAiNFiN running')"),'startup log must use the canonical product display name');
assert(browserWorkflow.includes("grep -qi '^location: /admin/setup' /tmp/setup-post.headers"),'clean-install CI must verify the guided setup handoff');
assert(browserWorkflow.includes('0 of 9 optional capabilities are configured'),'clean-install CI must verify the new optional setup language');
assert(browserWorkflow.includes("grep -qi '^location: /admin/setup' /tmp/setup-locked.headers"),'clean-install CI must verify installer lock redirects signed-in admins to guided Setup');

console.log('first-run installer smoke: ok');
