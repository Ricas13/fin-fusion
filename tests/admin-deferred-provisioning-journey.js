'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
const {query,transaction,getPool}=require('../src/db');
const planCreate=require('../src/platform/admin-plan-create-v2');

const BASE=String(process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030').replace(/\/$/,'');
const USER=process.env.BROWSER_ADMIN_USERNAME||'browseradmin';
const PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||'BrowserAuditPass!2026';
const CUSTOMER='browserdeferredcustomer';
const EMAIL='browserdeferredcustomer@example.invalid';
const CUSTOMER_PASSWORD='DeferredCustomerPass!2026';
const PLAN='browser-jellyfin-deferred';
const OUT=path.join(process.cwd(),'test-results','admin-browser');
fs.mkdirSync(OUT,{recursive:true});

async function settle(page){await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});}
async function gotoPage(page,url){const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await settle(page);return response;}
async function cleanupFixture(){
  await transaction(async client=>{
    const users=(await client.query(`SELECT id FROM app_users WHERE lower(username)=lower($1) OR lower(COALESCE(email,''))=lower($2)`,[CUSTOMER,EMAIL])).rows.map(row=>row.id);
    const customers=(await client.query(`SELECT id,user_id FROM customers WHERE user_id=ANY($1::uuid[]) OR lower(COALESCE(email,''))=lower($2) OR display_name=$3`,[users,EMAIL,'Browser Deferred Customer'])).rows;
    const customerIds=customers.map(row=>row.id);
    const userIds=[...new Set([...users,...customers.map(row=>row.user_id).filter(Boolean)])];
    if(customerIds.length)await client.query('DELETE FROM customers WHERE id=ANY($1::uuid[])',[customerIds]);
    if(userIds.length){
      await client.query('DELETE FROM auth_events WHERE user_id=ANY($1::uuid[])',[userIds]);
      await client.query("SELECT set_config('steamfusion.allow_audit_mutation','on',true)");
      try{
        await client.query("DELETE FROM app_users WHERE id=ANY($1::uuid[]) AND role='customer'",[userIds]);
      }finally{
        await client.query("SELECT set_config('steamfusion.allow_audit_mutation','off',true)");
      }
    }
    await client.query('DELETE FROM plans WHERE code=$1',[PLAN]);
  });
}
async function signInAdmin(page){
  await gotoPage(page,`${BASE}/login`);
  await page.locator('#username').fill(USER);await page.locator('#password').fill(PASSWORD);
  await Promise.all([page.waitForURL(url=>url.pathname.startsWith('/admin'),{timeout:15000}),page.getByRole('button',{name:'Sign in'}).click()]);
  await settle(page);
}
async function shot(page,name){await page.screenshot({path:path.join(OUT,`journey-${name}.png`),fullPage:true});}

async function main(){
  const browser=await chromium.launch({headless:true});
  try{
    await cleanupFixture();
    const parsed=planCreate.parse({
      __submitted:'1',code:PLAN,name:'Browser Deferred Jellyfin',description:'Deferred provisioning browser fixture',
      serviceType:'jellyfin',audience:'direct',billingInterval:'month',durationDays:'30',price:'5',currency:'GBP',
      capacityLimit:'20',streams:'2',serverClass:'premium',sortOrder:'900',visible:'on',active:'on',allowAudioTranscoding:'on',allowRemoteAccess:'on'
    });
    await planCreate.create(parsed,null);

    const adminContext=await browser.newContext({viewport:{width:1440,height:1000}}),admin=await adminContext.newPage();await signInAdmin(admin);
    await gotoPage(admin,`${BASE}/admin/users/new`);
    const form=admin.locator('form[action="/admin/users/new"]');
    assert.equal(await form.count(),1,'Add customer form is missing');
    await form.locator('input[name="username"]').fill(CUSTOMER);
    await form.locator('input[name="email"]').fill(EMAIL);
    await form.locator('input[name="displayName"]').fill('Browser Deferred Customer');
    await form.locator('select[name="planCode"]').selectOption(PLAN);
    await form.locator('select[name="provisioningMode"]').selectOption('after_activation');
    await Promise.all([admin.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),form.getByRole('button',{name:'Create customer'}).click()]);
    await settle(admin);
    const resultText=await admin.locator('body').innerText();
    assert(/Customer created/.test(resultText),'Deferred customer creation did not reach its result page');
    assert(/will be (?:prepared|provisioned) when activation completes/i.test(resultText),'Deferred provisioning status is not explained on creation');
    const activationLink=(await admin.locator('.codeBox').textContent()||'').trim();
    assert(/\/activate\//.test(activationLink),'Deferred customer creation did not expose an activation link');
    await shot(admin,'deferred-created');

    const before=(await query(`SELECT c.id,c.user_id,u.active,(SELECT COUNT(*)::int FROM subscriptions s WHERE s.customer_id=c.id) subscriptions,(SELECT COUNT(*)::int FROM jellyfin_accounts ja WHERE ja.customer_id=c.id) jellyfin_accounts FROM customers c JOIN app_users u ON u.id=c.user_id WHERE lower(u.username)=lower($1)`,[CUSTOMER])).rows[0];
    assert(before,'Deferred customer was not stored');
    assert.equal(before.active,false,'Deferred customer activated before claiming the account');
    assert.equal(Number(before.subscriptions),1,'Deferred customer did not receive its entitlement before activation');
    assert.equal(Number(before.jellyfin_accounts),0,'Deferred customer was provisioned before account activation');

    const customerContext=await browser.newContext({viewport:{width:1280,height:900}}),customer=await customerContext.newPage();
    const activationResponse=await gotoPage(customer,activationLink);
    assert(activationResponse&&activationResponse.status()===200,'Deferred activation link was not accepted');
    await customer.locator('input[name="password"]').fill(CUSTOMER_PASSWORD);
    await customer.locator('input[name="confirmPassword"]').fill(CUSTOMER_PASSWORD);
    await Promise.all([customer.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),customer.getByRole('button',{name:'Activate account'}).click()]);
    await settle(customer);
    assert(/Account activated/.test(await customer.locator('body').innerText()),'Jellyfin unavailability blocked portal account activation');
    await shot(customer,'deferred-activated-without-server');

    const after=(await query(`SELECT u.active,(SELECT COUNT(*)::int FROM subscriptions s WHERE s.customer_id=c.id) subscriptions,(SELECT COUNT(*)::int FROM jellyfin_accounts ja WHERE ja.customer_id=c.id) jellyfin_accounts FROM customers c JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[before.id])).rows[0];
    assert.equal(after.active,true,'Deferred customer portal account did not activate');
    assert.equal(Number(after.subscriptions),1,'Deferred entitlement was lost during activation');
    assert.equal(Number(after.jellyfin_accounts),0,'A Jellyfin account was recorded despite having no eligible server');
    const run=(await query(`SELECT status,detail FROM provisioning_runs WHERE customer_id=$1 AND action='reconcile' ORDER BY started_at DESC LIMIT 1`,[before.id])).rows[0];
    assert(run&&run.status==='failed','Deferred provisioning failure was not recorded as an operator-visible failed run');
    assert(/No eligible Jellyfin server/.test(String(run.detail?.error||'')),'Deferred provisioning failure does not explain the missing server capacity');
    const audit=(await query(`SELECT COUNT(*)::int count FROM audit_log WHERE action='customer.activation.provisioning_failed' AND entity_id=$1`,[before.id])).rows[0]?.count;
    assert(Number(audit)===1,'Activation did not audit the deferred provisioning failure');

    await customer.getByRole('link',{name:'Continue to sign in'}).click();await customer.waitForLoadState('domcontentloaded');await settle(customer);
    await customer.locator('input[name="identity"]').fill(CUSTOMER);await customer.locator('input[name="password"]').fill(CUSTOMER_PASSWORD);
    await Promise.all([customer.waitForURL(url=>url.pathname==='/account',{timeout:15000}),customer.getByRole('button',{name:'Sign in'}).click()]);
    await settle(customer);
    assert.equal(new URL(customer.url()).pathname,'/account','Customer with pending Jellyfin provisioning cannot use the portal');
    await shot(customer,'deferred-customer-portal');

    await gotoPage(admin,`${BASE}/admin/provisioning`);
    // A fresh blocked attempt is deliberately not promoted as an intervention.
    // It must still remain discoverable in the diagnostic access-state disclosure.
    const accessState=admin.locator('details.operatorDetails').filter({hasText:'All customer access state'}).first();
    assert.equal(await accessState.count(),1,'Provisioning diagnostics disclosure is missing');
    await accessState.locator('summary').click();
    const provisioningText=await admin.locator('body').innerText();
    assert(provisioningText.includes('Browser Deferred Customer'),'Failed deferred provisioning is not discoverable in Automation → Provisioning diagnostics');
    assert(/No eligible Jellyfin server/.test(provisioningText),'Provisioning diagnostics hide the reason deferred access could not be created');
    await shot(admin,'deferred-provisioning-attention');

    await adminContext.close();await customerContext.close();
    console.log('deferred activation → provisioning failure journey: ok');
  }finally{
    await browser.close();
    await cleanupFixture().catch(error=>console.warn('Deferred fixture cleanup failed:',error.message));
    await getPool().end();
  }
}

main().catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
