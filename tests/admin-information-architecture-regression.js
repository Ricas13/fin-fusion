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

async function signIn(page){await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});await page.locator('#username').fill(USER);await page.locator('#password').fill(PASSWORD);await Promise.all([page.waitForURL(url=>url.pathname.startsWith('/admin'),{timeout:15000}),page.getByRole('button',{name:'Sign in'}).click()]);}
async function labels(locator){return(await locator.allTextContents()).map(x=>x.trim()).filter(Boolean);}
async function screenshot(page,name){await page.screenshot({path:path.join(OUT,`ia-${name}.png`),fullPage:true});}
async function gotoAdmin(page,url){const response=await page.goto(`${BASE}${url}`,{waitUntil:'domcontentloaded',timeout:20000});assert(response&&response.status()<400,`${url} returned ${response?.status()}`);await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});return response;}
async function submit(form,button){await Promise.all([form.page().waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),form.getByRole('button',{name:button}).click()]);await form.page().waitForLoadState('load',{timeout:10000}).catch(()=>{});}
async function submitAction(page,form,button,pathname){const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===pathname,{timeout:15000});await form.getByRole('button',{name:button}).click();await response;}
async function operationsValue(pool){return(await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='operations_v1'`)).rows[0]?.setting_value||{};}

async function main(){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const plan=(await pool.query(`SELECT id FROM plans WHERE code='browser-stremio-addon' LIMIT 1`)).rows[0];
  assert(plan?.id,'The main browser workflow did not leave its Stremio regression plan available for IA checks');
  const id=encodeURIComponent(plan.id);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});await signIn(page);

    await gotoAdmin(page,'/admin/plans?type=stremio');
    const row=page.locator('.planListRow').filter({hasText:'browser-stremio-addon'}).first();
    assert.equal(await row.count(),1,'Stremio regression plan is missing from the catalogue');
    assert.equal(await row.locator('a[href$="/delivery"]').count(),0,'Plan list still exposes an arbitrary Delivery shortcut');
    assert.equal(await row.locator('a[href$="/lifecycle"]').count(),0,'Stremio plan list still exposes Jellyfin lifecycle/usage rules');
    await screenshot(page,'plans-list-stremio');

    // Specific-plan workflow pages must not create a second navigation row.
    // Their owning Commerce → Plans destination stays active in the canonical
    // left sidebar while record-specific controls remain local.
    for(const suffix of ['edit','inventory','commerce']){
      await gotoAdmin(page,`/admin/plans/${id}/${suffix}`);
      assert.equal(await page.locator('.planWorkflowTabs').count(),0,`${suffix} still renders the retired plan workflow subtab row`);
      assert.deepStrictEqual(await labels(page.locator('.adminTab.active')),['Plans'],`${suffix} must keep Plans active in the sidebar`);
      assert.equal(await page.locator('.coherenceSectionTabs,.coherenceSubTabs,.coherenceOwnedTools').count(),0,`${suffix} still renders duplicate page-body navigation outside the sidebar`);
      const allTabs=await labels(page.locator('.operatorTabs a'));
      assert(!allTabs.includes('All plans')&&!allTabs.includes('Bundles'),`${suffix} still mixes catalogue filters into a specific plan`);
      await screenshot(page,`plan-${suffix}`);
    }
    await gotoAdmin(page,`/admin/plans/${id}/delivery`);
    assert.equal(new URL(page.url()).pathname,`/admin/plans/${plan.id}/edit`,'Legacy Stremio Delivery URL must resolve to the canonical editor');
    assert.equal(await page.locator('.planWorkflowTabs').count(),0,'Legacy Stremio Delivery redirect must not recreate the retired plan workflow subtab row');
    assert.deepStrictEqual(await labels(page.locator('.adminTab.active')),['Plans'],'Legacy Stremio Delivery redirect must remain owned by Plans in the sidebar');
    assert.equal(await page.locator('.coherenceSectionTabs,.coherenceSubTabs,.coherenceOwnedTools').count(),0,'Legacy Stremio Delivery redirect must not recreate duplicate page-body navigation');
    assert.equal(await page.locator('.planDeliveryTools').count(),0,'Canonical Stremio editor exposed Jellyfin-only delivery tools');
    const canonicalEditorText=await page.locator('body').innerText();
    assert(/Stremio sources/.test(canonicalEditorText)&&!/Delivery service/.test(canonicalEditorText),'Canonical Stremio editor must own source selection without exposing the retired Delivery screen');
    assert.equal(await page.locator('#sources.planConfigCard').count(),1,'Stremio source selection must use the shared plan configuration card');
    await screenshot(page,'plan-delivery-redirect');

    await gotoAdmin(page,'/admin/operations');
    assert.equal(new URL(page.url()).pathname,'/admin/servers','Legacy Operations page did not redirect to unified Servers');
    assert.deepStrictEqual(await labels(page.locator('.adminTab.active')),['Jellyfin'],'Unified server operations must keep Jellyfin as the permanent Jellyfin sidebar destination');
    const fleetText=await page.locator('body').innerText();
    assert(/Placement ready/.test(fleetText)&&/Sellable stream capacity/.test(fleetText)&&/Live streams/.test(fleetText),'Unified Servers is missing fleet placement readiness or sellable stream capacity');
    assert(!/Customer session lifetime/.test(fleetText)&&!/Public base URL/.test(fleetText),'Unified Servers still contains unrelated platform/security settings');
    const placementPolicyDetails=page.locator('details.operatorDetails').filter({has:page.locator('summary',{hasText:'Placement health policy'})}).first();
    assert.equal(await placementPolicyDetails.count(),1,'Server placement health policy disclosure is missing');
    const capacityDetails=page.locator('#capacity-preview');
    assert.equal(await capacityDetails.count(),1,'Server future capacity preview disclosure is missing');
    const fleetForm=page.locator('form[action="/admin/servers/operations/placement-policy"]');
    assert.equal(await fleetForm.count(),1,'Server placement policy form is missing');
    await placementPolicyDetails.evaluate(element=>{element.open=true;});
    await submit(fleetForm,'Save policy');
    assert(/Placement health policy saved/.test(await page.locator('body').innerText()),'Server placement policy did not round-trip');
    await screenshot(page,'servers-placement');

    const beforeGeneral=await operationsValue(pool);
    await gotoAdmin(page,'/admin/settings?section=general');
    let general=await page.locator('body').innerText();
    assert(/Public URL & regional format/.test(general)&&/Public base URL/.test(general)&&/Timezone/.test(general),'General does not own public URL/locale/timezone');
    assert(!/Default customer plan/.test(general)&&!/Default server priority/.test(general),'Dead workflow defaults returned to General');
    const settingsLinks=await labels(page.locator('[data-nav-section="settings"] .adminTab'));
    assert.deepStrictEqual(settingsLinks,['General','Security','Connections','System'],'Settings must expose exactly its four rail destinations');
    assert.equal(await page.locator('.adminSubTab').count(),0,'The rail must stay two levels deep -- no sub-tabs');
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
    await gotoAdmin(page,'/admin/settings?section=security');
    let security=await page.locator('body').innerText();
    assert(/Session & registration limits/.test(security)&&/Staff session lifetime/.test(security),'Security does not own session limits');
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

    // Stremio source management lives under the Stremio workflow, not Settings.
    // Managed CAPTAiNFiN servers and optional external fallbacks stay in one
    // control centre, but technical cache/credential detail is progressive.
    await pool.query(`DELETE FROM platform_settings WHERE setting_key='stremio_runtime_v1'`);
    await gotoAdmin(page,'/admin/settings/stremio');
    assert.equal(new URL(page.url()).pathname,'/admin/servers/stremio','Legacy Stremio settings URL did not redirect to Stremio → Sources');
    let stremioText=await page.locator('body').innerText();
    assert(/CAPTAiNFiN Jellyfin servers/.test(stremioText)&&/External Jellyfin fallbacks/.test(stremioText),'Stremio Sources must expose managed servers and external fallbacks');
    assert(/Add external Jellyfin source/.test(stremioText),'Stremio Sources is missing the independent external-source workflow');
    assert(/Choose where Stremio can find your library/.test(stremioText),'Stremio Sources must explain its normal operator task in plain language');
    assert(/Household IP leases/.test(stremioText),'Stremio Sources must expose household lease operations');
    assert.equal(await page.locator('.stremioJourneyStep').count(),0,'Stremio Sources must not render the retired setup journey cards');
    assert.deepStrictEqual(await labels(page.locator('.adminTab.active')),['Stremio'],'The single permanent Stremio sidebar destination must remain active on source management');
    const addSource=page.locator('form[action="/admin/servers/stremio"]');
    assert.equal(await addSource.count(),1,'External Jellyfin source form is missing');
    for(const field of ['name','baseUrl','username','password'])assert.equal(await addSource.locator(`[name="${field}"]`).count(),1,`Source form is missing ${field}`);
    assert.equal(await addSource.locator('[name="accessToken"]').count(),0,'Source form exposes raw access-token entry');
    let runtimeForm=page.locator('form[action="/admin/servers/stremio/runtime"]');
    assert(await runtimeForm.getByRole('button',{name:'Enable runtime'}).isDisabled(),'Runtime must remain disabled before a selected indexed source exists');
    await screenshot(page,'stremio-sources-empty');

    const seeded=(await pool.query(`INSERT INTO stremio_sources(name,enabled,source_kind,base_url,public_url,jellyfin_user_id,jellyfin_username,access_token_encrypted,weight,priority,authorization_confirmed,auth_state,last_connected_at,last_auth_check_at)
      VALUES('Browser External Jellyfin',TRUE,'external','https://jellyfin.example.invalid','https://jellyfin.example.invalid','browser-user-id','browser-source-user','encrypted-test-token',100,50,TRUE,'connected',NOW(),NOW()) RETURNING id`)).rows[0];
    await pool.query(`INSERT INTO stremio_source_libraries(source_id,library_id,name,collection_type,selected,available) VALUES($1,'movies-lib','Movies','movies',TRUE,TRUE),($1,'tv-lib','TV Shows','tvshows',FALSE,TRUE)`,[seeded.id]);
    await pool.query(`INSERT INTO stremio_source_index_state(source_id,status,last_mode,last_started_at,last_completed_at,last_full_completed_at,next_incremental_at,force_full,item_count) VALUES($1,'ready','full',NOW(),NOW(),NOW(),NOW()+INTERVAL '6 hours',FALSE,42)`,[seeded.id]);

    await gotoAdmin(page,`/admin/servers/stremio/${encodeURIComponent(seeded.id)}`);
    assert.equal(new URL(page.url()).pathname,'/admin/servers/stremio','Legacy source-detail URL did not redirect to the consolidated Stremio Sources page');
    const externalRow=page.locator(`#external-${seeded.id}`);
    assert.equal(await externalRow.count(),1,'Seeded external Jellyfin source is missing from the consolidated source list');
    const disclosure=externalRow.locator('details.capabilitySourceDisclosure');
    assert.equal(await disclosure.count(),1,'External source library and advanced controls are missing');
    await disclosure.evaluate(element=>{element.open=true;});
    const externalText=await externalRow.innerText();
    assert(/Browser External Jellyfin/.test(externalText)&&/Movies/.test(externalText)&&/TV Shows/.test(externalText),'External source row does not show discovered libraries');
    assert(await externalRow.locator('input[name="libraryId"][value="movies-lib"]').isChecked(),'Selected library state did not round-trip');
    assert(!(await externalRow.locator('input[name="libraryId"][value="tv-lib"]').isChecked()),'Unselected library was incorrectly enabled');
    assert(/every 3 hours/i.test(externalText)&&/twice weekly/i.test(externalText),'External source row does not explain automatic refresh cadence');
    assert(/dedicated playback account/i.test(externalText),'External source row must hide token-rotation detail from the normal summary');
    await screenshot(page,'stremio-source-libraries');

    await gotoAdmin(page,`/admin/plans/${id}/edit`);
    let planText=await page.locator('body').innerText();
    assert(/Stremio sources/.test(planText)&&/additional Jellyfin sources/i.test(planText)&&/Browser External Jellyfin/.test(planText),'Canonical Stremio editor does not expose source selection in the shared configuration card');
    assert(/Household IPs/.test(planText),'Normal Stremio plan controls must expose the household access allowance');
    const sourceForm=page.locator(`form[action="/admin/plans/${plan.id}/stremio-sources"]`);
    assert.equal(await sourceForm.count(),1,'Canonical Stremio editor is missing its source-selection form');
    await sourceForm.locator(`input[name="sourceId"][value="${seeded.id}"]`).check();
    const priorityInput=sourceForm.locator(`input[name="priority_${seeded.id}"]`);
    assert.equal(await priorityInput.count(),1,'External source priority control is missing');
    await priorityInput.fill('10');
    await submitAction(page,sourceForm,'Save sources',`/admin/plans/${plan.id}/stremio-sources`);
    const mapping=(await pool.query('SELECT enabled,priority FROM plan_stremio_sources WHERE plan_id=$1 AND source_id=$2',[plan.id,seeded.id])).rows[0];
    assert.equal(mapping?.enabled,true,'Plan source mapping was not persisted');
    assert.equal(Number(mapping?.priority),10,'Plan source priority was not persisted');
    await page.waitForFunction(()=>/1\/1 selected source ready/i.test(document.body.innerText),null,{timeout:15000});
    planText=await page.locator('body').innerText();
    assert(/1\/1 selected source ready/i.test(planText),'Canonical Stremio editor does not surface selected-source readiness');
    assert(await page.locator(`form[action="/admin/plans/${plan.id}/stremio-sources"] input[name="sourceId"][value="${seeded.id}"]`).isChecked(),'Saved source selection did not round-trip in the canonical editor');
    await screenshot(page,'plan-editor-stremio-source');

    await gotoAdmin(page,'/admin/servers/stremio');
    runtimeForm=page.locator('form[action="/admin/servers/stremio/runtime"]');
    assert(!(await runtimeForm.getByRole('button',{name:'Enable runtime'}).isDisabled()),'Ready external source did not unlock runtime enablement');
    await submitAction(page,runtimeForm,'Enable runtime','/admin/servers/stremio/runtime');
    await page.waitForFunction(()=>document.body.innerText.includes('Stremio runtime enabled.'),null,{timeout:15000});
    let stored=(await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='stremio_runtime_v1'`)).rows[0]?.setting_value;
    assert.equal(stored?.enabled,true,'Stremio runtime enablement was not persisted');
    runtimeForm=page.locator('form[action="/admin/servers/stremio/runtime"]');
    await submitAction(page,runtimeForm,'Disable runtime','/admin/servers/stremio/runtime');
    await page.waitForFunction(()=>document.body.innerText.includes('Stremio runtime disabled.'),null,{timeout:15000});
    stored=(await pool.query(`SELECT setting_value FROM platform_settings WHERE setting_key='stremio_runtime_v1'`)).rows[0]?.setting_value;
    assert.equal(stored?.enabled,false,'Stremio runtime disablement was not persisted');
    await screenshot(page,'stremio-sources-runtime');

    await pool.query('DELETE FROM plan_stremio_sources WHERE source_id=$1',[seeded.id]);
    await pool.query('DELETE FROM stremio_sources WHERE id=$1',[seeded.id]);

    console.log('admin information architecture regression: ok');
  }finally{await browser.close();await pool.end();}
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});