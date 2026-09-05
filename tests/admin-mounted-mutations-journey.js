'use strict';

const assert=require('assert');
const {chromium}=require('playwright');
const {Pool}=require('pg');

const BASE=process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030';
const USER=process.env.BROWSER_ADMIN_USERNAME||'admin';
const PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||'';

async function login(page){
  await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
  await page.fill('#username',USER);
  await page.fill('#password',PASSWORD);
  await Promise.all([
    page.waitForNavigation({waitUntil:'domcontentloaded'}),
    page.click('button[type="submit"]')
  ]);
  assert(new URL(page.url()).pathname.startsWith('/admin'),'mounted mutation journey did not authenticate into admin');
}

async function assertPaymentWebhookOwnership(request){
  const mounted=await request.post(`${BASE}/webhooks/stripe`,{
    headers:{'content-type':'application/json'},
    data:'{}',
    maxRedirects:0
  });
  assert.equal(mounted.status(),404,'disabled Stripe webhook should deliberately return 404');
  assert.equal(await mounted.text(),'','Stripe webhook POST must come from the mounted provider handler, not the application fallback');

  const wrongMethod=await request.get(`${BASE}/webhooks/stripe`,{maxRedirects:0});
  assert.equal(wrongMethod.status(),404,'unmounted Stripe webhook method should reach the application fallback');
  assert.equal(await wrongMethod.text(),'Not found','GET on the webhook path must be distinguishable from the mounted POST handler');
}

async function assertSupportPolicyMutation(page,pool){
  const response=await page.goto(`${BASE}/admin/settings/support`,{waitUntil:'domcontentloaded'});
  assert(response&&response.status()<400,'support settings page is not mounted');

  const form=page.locator('form[action="/admin/settings/support"]');
  assert.equal(await form.count(),1,'canonical support settings form is missing');

  for(const [name,help] of [
    ['supportEmail','Public contact address customers can use when they need help.'],
    ['termsUrl','Public URL containing the service terms customers should be able to review.'],
    ['privacyUrl','Public URL containing the privacy information customers should be able to review.']
  ]){
    const input=form.locator(`[name="${name}"]`);
    assert.equal(await input.count(),1,`${name} input is missing`);
    const group=input.locator('xpath=..');
    assert.equal((await group.locator('.fieldHelp').textContent()).trim(),help,`${name} help must be rendered by its owning field`);
  }

  await form.locator('[name="supportEmail"]').fill('runtime-proof@example.test');
  await form.locator('[name="termsUrl"]').fill('https://example.test/terms');
  await form.locator('[name="privacyUrl"]').fill('https://example.test/privacy');
  await Promise.all([
    page.waitForNavigation({waitUntil:'domcontentloaded'}),
    form.locator('button[type="submit"],button:not([type])').last().click()
  ]);
  assert.equal(new URL(page.url()).pathname,'/admin/settings/support','support policy POST did not return to its canonical owner');

  const stored=await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='support_policy_v1'`);
  assert.equal(stored.rowCount,1,'support policy mutation did not persist platform state');
  assert.equal(stored.rows[0].setting_value.supportEmail,'runtime-proof@example.test');
  assert.equal(stored.rows[0].setting_value.termsUrl,'https://example.test/terms');
  assert.equal(stored.rows[0].setting_value.privacyUrl,'https://example.test/privacy');
}

async function assertPersonalNotificationMutation(page,pool,adminUserId){
  const events=await pool.query(`SELECT event_type,email_enabled,telegram_enabled,discord_enabled FROM notification_preferences WHERE event_scope IN ('admin','both') ORDER BY event_type`);
  const event=events.rows.find(row=>row.email_enabled||row.telegram_enabled||row.discord_enabled);
  assert(event,'notification fixture has no globally enabled administrator event/channel to exercise');
  const channel=['email','telegram','discord'].find(name=>event[`${name}_enabled`]);
  assert(channel,'notification event has no available channel');

  await pool.query(`INSERT INTO admin_notification_preferences(admin_user_id,event_type,channel,enabled) VALUES($1,$2,$3,FALSE) ON CONFLICT(admin_user_id,event_type,channel) DO UPDATE SET enabled=FALSE,updated_at=NOW()`,[adminUserId,event.event_type,channel]);

  const response=await page.goto(`${BASE}/admin/profile/notifications`,{waitUntil:'domcontentloaded'});
  assert(response&&response.status()<400,'personal notification page is not mounted');
  const form=page.locator('form[action="/admin/profile/notifications"]');
  assert.equal(await form.count(),1,'personal notification mutation form is missing');
  const checkbox=form.locator(`input[name="${channel}__${event.event_type}"]`);
  assert.equal(await checkbox.count(),1,'selected notification event/channel is missing from mounted form');
  assert(!(await checkbox.isDisabled()),'selected notification event/channel is disabled despite global availability');
  await checkbox.evaluate(element=>{
    element.checked=true;
    element.dispatchEvent(new Event('change',{bubbles:true}));
  });
  assert(await checkbox.isChecked(),'selected notification event/channel was not checked in the real form');

  await Promise.all([
    page.waitForNavigation({waitUntil:'domcontentloaded'}),
    form.getByRole('button',{name:'Save my notifications'}).click()
  ]);
  assert.equal(new URL(page.url()).pathname,'/admin/profile/notifications','personal notification POST did not return to mounted owner');

  const stored=await pool.query(`SELECT enabled FROM admin_notification_preferences WHERE admin_user_id=$1 AND event_type=$2 AND channel=$3`,[adminUserId,event.event_type,channel]);
  assert.equal(stored.rowCount,1,'personal notification mutation did not persist a preference row');
  assert.equal(stored.rows[0].enabled,true,'personal notification mounted POST did not persist the selected channel');
  const audit=await pool.query(`SELECT 1 FROM audit_log WHERE actor_user_id=$1 AND action='admin.notifications.personal.update' LIMIT 1`,[adminUserId]);
  assert.equal(audit.rowCount,1,'personal notification mounted POST did not write its audit record');
}

async function csrfForStremio(page){
  const response=await page.goto(`${BASE}/admin/servers/stremio`,{waitUntil:'domcontentloaded'});
  assert(response&&response.status()<400,'canonical Stremio page is not mounted');
  const form=page.locator('form[action="/admin/servers/stremio/runtime"]');
  assert.equal(await form.count(),1,'canonical Stremio runtime form is missing');
  return form.locator('input[name="_csrf"]').inputValue();
}

async function seedStremioRuntime(pool,enabled){
  await pool.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('stremio_runtime_v1',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:Boolean(enabled)})]);
}

async function assertStremioRuntimeOwnership(page,request,pool){
  const csrf=await csrfForStremio(page);

  await seedStremioRuntime(pool,true);
  const canonical=await request.post(`${BASE}/admin/servers/stremio/runtime`,{
    form:{_csrf:csrf,enabled:'0'},
    maxRedirects:0
  });
  assert.equal(canonical.status(),302,'canonical Stremio runtime mutation should redirect after save');
  let stored=await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='stremio_runtime_v1'`);
  assert.equal(stored.rows[0]?.setting_value?.enabled,false,'canonical Stremio runtime POST did not persist disabled state');

  await seedStremioRuntime(pool,true);
  const legacy=await request.post(`${BASE}/admin/settings/stremio/runtime`,{
    form:{_csrf:csrf,enabled:'0'},
    maxRedirects:0
  });
  assert.equal(legacy.status(),307,'legacy Stremio runtime POST must be compatibility-only');
  assert.equal(legacy.headers().location,'/admin/servers/stremio/runtime','legacy Stremio runtime POST must redirect to canonical owner');
  stored=await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='stremio_runtime_v1'`);
  assert.equal(stored.rows[0]?.setting_value?.enabled,true,'legacy Stremio compatibility route must not mutate runtime state itself');

  const forwarded=await request.post(`${BASE}${legacy.headers().location}`,{
    form:{_csrf:csrf,enabled:'0'},
    maxRedirects:0
  });
  assert.equal(forwarded.status(),302,'canonical Stremio owner did not accept the compatibility POST body');
  stored=await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='stremio_runtime_v1'`);
  assert.equal(stored.rows[0]?.setting_value?.enabled,false,'compatibility flow did not finish through canonical Stremio owner');
}

async function main(){
  assert(PASSWORD,'BROWSER_ADMIN_PASSWORD is required');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage();
    await login(page);
    const admin=await pool.query(`SELECT id FROM app_users WHERE username=$1 AND role='admin' LIMIT 1`,[USER]);
    assert.equal(admin.rowCount,1,'browser administrator fixture is missing');
    const adminUserId=admin.rows[0].id;

    await assertPaymentWebhookOwnership(context.request);
    await assertSupportPolicyMutation(page,pool);
    await assertPersonalNotificationMutation(page,pool,adminUserId);
    await assertStremioRuntimeOwnership(page,context.request,pool);

    await context.close();
    console.log('mounted admin mutation journey: ok');
  }finally{
    await browser.close();
    await pool.end();
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
