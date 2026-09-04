'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
const {Pool}=require('pg');

const BASE=String(process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030').replace(/\/$/,'');
const USER=process.env.BROWSER_ADMIN_USERNAME||'browseradmin';
const PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||'BrowserAuditPass!2026';
const CUSTOMER='browserportalcustomer';
const EMAIL='browserportalcustomer@example.invalid';
const CUSTOMER_PASSWORD='CustomerPortalPass!2026';
const OUT=path.join(process.cwd(),'test-results','admin-browser');
fs.mkdirSync(OUT,{recursive:true});

async function settle(page){await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});}
async function gotoPage(page,url){const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await settle(page);return response;}
async function signInAdmin(page){
  await gotoPage(page,`${BASE}/login`);
  await page.locator('#username').fill(USER);await page.locator('#password').fill(PASSWORD);
  await Promise.all([page.waitForURL(url=>url.pathname.startsWith('/admin'),{timeout:15000}),page.getByRole('button',{name:'Sign in'}).click()]);
  await settle(page);
}
async function shot(page,name){await page.screenshot({path:path.join(OUT,`journey-${name}.png`),fullPage:true});}

async function main(){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  try{
    const adminContext=await browser.newContext({viewport:{width:1440,height:1000}});
    const admin=await adminContext.newPage();await signInAdmin(admin);

    await gotoPage(admin,`${BASE}/admin/users/new`);
    const form=admin.locator('form[action="/admin/users/new"]');
    assert.equal(await form.count(),1,'Add customer form is missing');
    await form.locator('input[name="username"]').fill(CUSTOMER);
    await form.locator('input[name="email"]').fill(EMAIL);
    await form.locator('input[name="displayName"]').fill('Browser Portal Customer');
    await form.locator('select[name="provisioningMode"]').selectOption('portal_only');
    await Promise.all([admin.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),form.getByRole('button',{name:'Create customer'}).click()]);
    await settle(admin);
    const createdText=await admin.locator('body').innerText();
    assert(/Customer created/.test(createdText),'Native customer creation did not show the one-time result page');
    assert(/Portal-only customer created; no streaming entitlement was created/.test(createdText),'Portal-only creation status is unclear or changed');
    const activationLink=(await admin.locator('.codeBox').textContent()||'').trim();
    assert(/^https?:\/\//.test(activationLink)&&/\/activate\//.test(activationLink),'Customer creation did not expose the one-time activation link');
    await shot(admin,'customer-created');

    const dbCustomer=(await pool.query(`SELECT c.id,c.user_id,u.active,(SELECT COUNT(*)::int FROM subscriptions s WHERE s.customer_id=c.id) subscriptions FROM customers c JOIN app_users u ON u.id=c.user_id WHERE lower(u.username)=lower($1)`,[CUSTOMER])).rows[0];
    assert(dbCustomer,'Created customer was not persisted');
    assert.equal(Number(dbCustomer.subscriptions),0,'Portal-only customer unexpectedly received a streaming subscription');
    assert.equal(dbCustomer.active,false,'Customer became active before using the activation link');

    await gotoPage(admin,`${BASE}/admin/users`);
    const customerLink=admin.locator(`a[href="/admin/users/${dbCustomer.id}"]`).first();
    assert.equal(await customerLink.count(),1,'Customers list does not link the real customer to Customer 360');
    const customer360ResponsePromise=admin.waitForResponse(response=>new URL(response.url()).pathname===`/admin/users/${dbCustomer.id}`&&response.request().resourceType()==='document',{timeout:15000});
    await customerLink.click();
    const customer360Response=await customer360ResponsePromise;
    await admin.waitForLoadState('domcontentloaded');await settle(admin);
    assert(customer360Response.status()<400,`Clicking a customer opened Customer 360 with HTTP ${customer360Response.status()}`);
    assert.equal(new URL(admin.url()).pathname,`/admin/users/${dbCustomer.id}`,'Customer link did not land on the Customer 360 record');
    const customer360Text=await admin.locator('body').innerText();
    assert(/Browser Portal Customer/.test(customer360Text),'Customer 360 did not render the selected customer identity');
    assert(/Customer \/ Portal/.test(customer360Text)&&/Plans & Subscriptions/.test(customer360Text),'Action-first Customer 360 cards did not render');
    assert(!/Not found|Request failed/i.test(customer360Text),'Customer 360 rendered an error after clicking a real customer');

    // The action-first Customer / Portal card must expose the canonical account
    // lifecycle route directly. This account is intentionally still inactive,
    // so trying to enable it before password setup must be rejected safely and
    // must return through the mounted Customer 360 owner rather than falling
    // through to a generic 404/AJAX failure.
    const statusForm=admin.locator(`form[action="/admin/users/${dbCustomer.id}/manage/portal/status"]`);
    await statusForm.waitFor({state:'visible',timeout:15000});
    assert.equal(await statusForm.count(),1,'Customer / Portal enable action is missing');
    assert.equal(await statusForm.locator('input[name="active"]').inputValue(),'1','inactive customer should render the enable action');
    await shot(admin,'customer-360');
    await Promise.all([
      admin.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),
      statusForm.getByRole('button',{name:'Enable portal'}).click()
    ]);
    await settle(admin);
    assert.equal(new URL(admin.url()).pathname,`/admin/users/${dbCustomer.id}`,'Portal-status action did not return through the mounted Customer 360 owner');
    const statusResultText=await admin.locator('body').innerText();
    assert(/onboarding link|choose their password|password/i.test(statusResultText),'Mounted portal-status handler did not return its expected pre-onboarding validation');
    assert(!/Not found|Request failed/i.test(statusResultText),'Portal-status action fell through to the global Not found/request failure path');
    await shot(admin,'portal-status-mounted');

    // Duplicate creation must explain the problem rather than create a second identity.
    await gotoPage(admin,`${BASE}/admin/users/new`);
    const duplicate=admin.locator('form[action="/admin/users/new"]');
    await duplicate.locator('input[name="username"]').fill(CUSTOMER);
    await duplicate.locator('input[name="email"]').fill(EMAIL);
    await duplicate.locator('select[name="provisioningMode"]').selectOption('portal_only');
    await Promise.all([admin.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),duplicate.getByRole('button',{name:'Create customer'}).click()]);
    await settle(admin);
    const duplicateText=await admin.locator('body').innerText();
    assert(/username or email already exists/i.test(duplicateText),'Duplicate customer creation did not produce an actionable identity error');
    assert(!/Request failed/i.test(duplicateText),'Duplicate customer creation was masked as a generic request failure');

    const customerContext=await browser.newContext({viewport:{width:1280,height:900}});
    const customer=await customerContext.newPage();
    let response=await gotoPage(customer,activationLink);
    assert(response&&response.status()===200,'Fresh activation link was not accepted');
    assert(/Activate your account/.test(await customer.locator('body').innerText()),'Activation page is unclear');
    await customer.locator('input[name="password"]').fill(CUSTOMER_PASSWORD);
    await customer.locator('input[name="confirmPassword"]').fill(CUSTOMER_PASSWORD);
    await Promise.all([customer.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),customer.getByRole('button',{name:'Activate account'}).click()]);
    await settle(customer);
    assert(/Account activated/.test(await customer.locator('body').innerText()),'Customer activation did not complete cleanly');
    await shot(customer,'account-activated');

    const replay=await customerContext.newPage();
    response=await gotoPage(replay,activationLink);
    assert(response&&response.status()===410,'Consumed activation token remained reusable');
    assert(/invalid, expired or already used/i.test(await replay.locator('body').innerText()),'Consumed activation token does not explain why it is unavailable');
    await replay.close();

    await customer.getByRole('link',{name:'Continue to sign in'}).click();
    await customer.waitForLoadState('domcontentloaded');await settle(customer);
    assert.equal(new URL(customer.url()).pathname,'/account/login','Activation did not continue to customer sign-in');
    await customer.locator('input[name="identity"]').fill(CUSTOMER);
    await customer.locator('input[name="password"]').fill(CUSTOMER_PASSWORD);
    await Promise.all([customer.waitForURL(url=>url.pathname==='/account',{timeout:15000}),customer.getByRole('button',{name:'Sign in'}).click()]);
    await settle(customer);
    assert.equal(new URL(customer.url()).pathname,'/account','Newly activated customer could not sign in');
    const accountText=await customer.locator('body').innerText();
    assert(!/Not found|Request failed/i.test(accountText),'Customer portal failed immediately after activation');
    await shot(customer,'customer-portal');

    const active=(await pool.query(`SELECT active FROM app_users WHERE id=$1`,[dbCustomer.user_id])).rows[0]?.active;
    assert.equal(active,true,'Customer account was not activated in the database');
    await adminContext.close();await customerContext.close();
    console.log('admin → customer activation journey: ok');
  }finally{await browser.close();await pool.end();}
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});
