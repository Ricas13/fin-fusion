'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
const {Pool}=require('pg');

const BASE=String(process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030').replace(/\/$/,'');
const USER=process.env.BROWSER_ADMIN_USERNAME||'browseradmin';
const PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||'BrowserAuditPass!2026';
const OUT=path.join(process.cwd(),'test-results','admin-browser');
fs.mkdirSync(OUT,{recursive:true});

async function signIn(page){
  await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
  await page.locator('#username').fill(USER);await page.locator('#password').fill(PASSWORD);
  await Promise.all([page.waitForURL(url=>url.pathname.startsWith('/admin'),{timeout:15000}),page.getByRole('button',{name:'Sign in'}).click()]);
}
async function labels(locator){return (await locator.allTextContents()).map(x=>x.trim()).filter(Boolean);}
async function screenshot(page,name){await page.screenshot({path:path.join(OUT,`ia-${name}.png`),fullPage:true});}
async function submit(form,button){await Promise.all([form.page().waitForNavigation({waitUntil:'networkidle',timeout:15000}),form.getByRole('button',{name:button}).click()]);}
async function operationsValue(pool){return (await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='operations_v1'`)).rows[0]?.setting_value||{};}

async function main(){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const plan=(await pool.query(`SELECT id FROM plans WHERE code='browser-stremio-addon' LIMIT 1`)).rows[0];
  assert(plan?.id,'The main browser workflow did not leave its Stremio regression plan available for IA checks');
  const id=encodeURIComponent(plan.id);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});await signIn(page);

    await page.goto(`${BASE}/admin/plans?type=stremio`,{waitUntil:'networkidle'});
    const row=page.locator('.planListRow').filter({hasText:'browser-stremio-addon'}).first();
    assert.equal(await row.count(),1,'Stremio regression plan is missing from the catalogue');
    assert.equal(await row.locator('a[href$="/delivery"]').count(),0,'Plan list still exposes an arbitrary Delivery shortcut');
    assert.equal(await row.locator('a[href$="/lifecycle"]').count(),0,'Stremio plan list still exposes Jellyfin lifecycle/usage rules');
    await screenshot(page,'plans-list-stremio');

    const expected=['Overview','Delivery','Availability','Commerce'];
    for(const [suffix,active] of [['edit','Overview'],['delivery','Delivery'],['inventory','Availability'],['commerce','Commerce']]){
      await page.goto(`${BASE}/admin/plans/${id}/${suffix}`,{waitUntil:'networkidle'});
      const workflow=page.locator('.planWorkflowTabs a');
      assert.deepStrictEqual(await labels(workflow),expected,`${suffix} has inconsistent plan workflow navigation`);
      assert.deepStrictEqual(await labels(page.locator('.planWorkflowTabs a.active')),[active],`${suffix} highlights the wrong plan workflow step`);
      const allTabs=await labels(page.locator('.operatorTabs a'));
      assert(!allTabs.includes('All plans')&&!allTabs.includes('Bundles')&&!allTabs.includes('Reseller'),`${suffix} still mixes catalogue filters into a specific plan`);
      if(suffix==='delivery')assert.equal(await page.locator('.planDeliveryTools').count(),0,'Stremio-only delivery exposed Jellyfin-only tools');
      await screenshot(page,`plan-${suffix}`);
    }

    await page.goto(`${BASE}/admin/operations`,{waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).pathname,'/admin/servers/operations','Legacy Operations page did not redirect to Fleet operations');
    assert.deepStrictEqual(await labels(page.locator('.adminTab.active')),['Fleet operations'],'Fleet operations is not owned by Servers in the sidebar');
    const fleetText=await page.locator('body').innerText();
    assert(/Placement health policy/.test(fleetText)&&/Placement dry run/.test(fleetText),'Fleet operations is missing placement controls');
    assert(!/Customer session lifetime/.test(fleetText)&&!/Public base URL/.test(fleetText),'Fleet operations still contains unrelated platform/security settings');
    const fleetForm=page.locator('form[action="/admin/servers/operations/placement-policy"]');
    assert.equal(await fleetForm.count(),1,'Fleet placement policy form is missing');
    await submit(fleetForm,'Save placement policy');
    assert(/Placement health policy saved/.test(await page.locator('body').innerText()),'Fleet placement policy did not round-trip');
    await screenshot(page,'fleet-operations');

    const beforeGeneral=await operationsValue(pool);
    await page.goto(`${BASE}/admin/settings?section=general`,{waitUntil:'networkidle'});
    let general=await page.locator('body').innerText();
    assert(/Public URL & regional format/.test(general)&&/Public base URL/.test(general)&&/Timezone/.test(general),'General does not own public URL/locale/timezone');
    assert(!/Default customer plan/.test(general)&&!/Default server priority/.test(general),'Dead workflow defaults returned to General');
    const settingsLinks=await labels(page.locator('[data-nav-section="settings"] .adminTab'));
    assert(!settingsLinks.includes('Operations'),'Retired Operations remains visible under Settings');
    const generalForm=page.locator('form[action="/admin/settings/runtime-general"]');
    assert.equal(await generalForm.count(),1,'General runtime form is missing');
    await submit(generalForm,'Save URL & regional settings');
    general=await page.locator('body').innerText();
    assert(/Public URL and regional settings saved/.test(general),'General runtime settings did not round-trip');
    const afterGeneral=await operationsValue(pool);
    assert.equal(afterGeneral.placementHealthMode,beforeGeneral.placementHealthMode,'Saving General reset the fleet placement-health policy');
    assert.equal(afterGeneral.staffSessionHours,beforeGeneral.staffSessionHours,'Saving General reset a Security setting');
    await screenshot(page,'settings-general');

    const beforeSecurity=await operationsValue(pool);
    await page.goto(`${BASE}/admin/settings?section=security`,{waitUntil:'networkidle'});
    let security=await page.locator('body').innerText();
    assert(/Session & registration limits/.test(security)&&/Staff\/reseller session lifetime/.test(security),'Security does not own session limits');
    assert(/Trusted outbound hostnames/.test(security)&&/Trusted private CIDRs/.test(security),'Security does not own private integration trust');
    assert(/Abandoned activation cleanup/.test(security),'Security does not own abandoned-registration cleanup');
    const securityForm=page.locator('form[action="/admin/settings/runtime-security"]');
    assert.equal(await securityForm.count(),1,'Security runtime form is missing');
    await submit(securityForm,'Save session & network security');
    security=await page.locator('body').innerText();
    assert(/Session and network security settings saved/.test(security),'Security runtime settings did not round-trip');
    const afterSecurity=await operationsValue(pool);
    assert.equal(afterSecurity.publicBaseUrl,beforeSecurity.publicBaseUrl,'Saving Security reset General public URL');
    assert.equal(afterSecurity.locale,beforeSecurity.locale,'Saving Security reset General locale');
    assert.equal(afterSecurity.placementHealthMode,beforeSecurity.placementHealthMode,'Saving Security reset Fleet placement policy');
    await screenshot(page,'settings-security');

    console.log('admin information architecture regression: ok');
  }finally{await browser.close();await pool.end();}
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});
