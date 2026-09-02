'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const { chromium }=require('playwright');
const { Pool }=require('pg');
const { encryptWithEnv }=require('../src/security/purpose-crypto');
const BASE=process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030';
const USER=process.env.BROWSER_ADMIN_USERNAME||'admin';
const PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||'';
const OUT=path.join(process.cwd(),'test-results','admin-browser');
fs.mkdirSync(OUT,{recursive:true});

function unique(values){return [...new Set(values)]}
function canonical(href){
  try{
    const u=new URL(href,BASE);
    if(u.origin!==new URL(BASE).origin)return null;
    if(!u.pathname.startsWith('/admin'))return null;
    if(u.pathname.startsWith('/admin/api/'))return null;
    if(u.pathname.includes(':'))return null;
    const searchKeys=[...u.searchParams.keys()];
    if(searchKeys.length&&searchKeys.every(key=>['range','from','to'].includes(key)))return u.pathname;
    return `${u.pathname}${u.search}`;
  }catch{return null}
}
function slug(value){return value.replace(/^\/admin\/?/,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'dashboard'}
function visibleText(value){return String(value||'').replace(/\s+/g,' ').trim()}

async function login(page){
  await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
  await page.fill('#username',USER);
  await page.fill('#password',PASSWORD);
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.click('button[type="submit"]')]);
  assert(new URL(page.url()).pathname.startsWith('/admin'),'browser login did not reach the admin area');
}
async function captureRuntime(page){
  return page.evaluate(()=>({
    h1:[...document.querySelectorAll('h1')].map(x=>x.textContent.trim()).filter(Boolean),
    activeSidebar:[...document.querySelectorAll('.adminTab.active')].map(x=>x.textContent.trim()).filter(Boolean),
    landmarks:{main:document.querySelectorAll('main').length,nav:document.querySelectorAll('nav').length,h1:document.querySelectorAll('h1').length},
    overflowX:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-window.innerWidth,
    focusables:[...document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return !el.disabled&&s.visibility!=='hidden'&&s.display!=='none'&&r.width>0&&r.height>0}).length
  }));
}
async function auditPage(page,url,{mobile=false}={}){
  const consoleErrors=[],pageErrors=[],requestFailures=[];
  const onConsole=msg=>{if(msg.type()==='error')consoleErrors.push(msg.text())};
  const onPageError=error=>pageErrors.push(error.message);
  const onRequestFailed=req=>requestFailures.push(`${req.method()} ${req.url()} ${req.failure()?.errorText||''}`);
  page.on('console',onConsole);page.on('pageerror',onPageError);page.on('requestfailed',onRequestFailed);
  try{
    let response;
    try{
      response=await page.goto(`${BASE}${url}`,{waitUntil:'domcontentloaded',timeout:20000});
    }catch(error){
      if(!/Download is starting/i.test(String(error?.message||error)))throw error;
      const downloadResponse=await page.context().request.get(`${BASE}${url}`,{timeout:20000,failOnStatusCode:false});
      const headers=downloadResponse.headers();
      const contentType=String(headers['content-type']||'');
      const contentDisposition=String(headers['content-disposition']||'');
      assert(downloadResponse.status()<400,`${url} download returned ${downloadResponse.status()}`);
      assert(/attachment/i.test(contentDisposition),`${url} started a download without attachment content disposition`);
      assert(!contentType.includes('text/html'),`${url} download unexpectedly returned HTML`);
      return{url,finalUrl:url,status:downloadResponse.status(),nonHtml:true,download:true,contentType,contentDisposition};
    }
    assert(response,`${url} did not return a response`);
    const contentType=String(response.headers()['content-type']||'');
    const final=new URL(page.url());
    if(!contentType.includes('text/html'))return{url,finalUrl:final.pathname+final.search,status:response.status(),nonHtml:true};
    await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});
    const metrics=await page.evaluate(()=>({
      links:[...document.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href'),text:a.textContent.trim(),download:a.hasAttribute('download')})),
      forms:[...document.querySelectorAll('form')].map(f=>({method:(f.getAttribute('method')||'get').toUpperCase(),action:new URL(f.action,location.href).pathname})),
      buttons:[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean),
      emptyLinks:[...document.querySelectorAll('a[href]')].filter(a=>!a.textContent.trim()&&!a.getAttribute('aria-label')&&!a.querySelector('img[alt]')).length,
      duplicateIds:Object.entries([...document.querySelectorAll('[id]')].reduce((m,el)=>(m[el.id]=(m[el.id]||0)+1,m),{})).filter(([,n])=>n>1),
      labelsMissing:[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(el=>!el.labels?.length&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')).map(el=>el.name||el.id||el.outerHTML.slice(0,80)),
      imagesMissingAlt:[...document.querySelectorAll('img:not([alt])')].length,
      headings:[...document.querySelectorAll('h1,h2,h3')].map(h=>({tag:h.tagName,text:h.textContent.trim()})),
      contentText:document.querySelector('main')?.innerText?.slice(0,3000)||''
    }));
    const runtime=await captureRuntime(page);
    if(response.status()>=400)throw new Error(`${url} returned ${response.status()}`);
    if(metrics.duplicateIds.length)throw new Error(`${url} has duplicate element IDs: ${JSON.stringify(metrics.duplicateIds)}`);
    if(metrics.emptyLinks)throw new Error(`${url} has ${metrics.emptyLinks} accessible-name-less links`);
    if(metrics.imagesMissingAlt)throw new Error(`${url} has ${metrics.imagesMissingAlt} images without alt attributes`);
    if(metrics.labelsMissing.length)throw new Error(`${url} has unlabeled controls: ${metrics.labelsMissing.join(', ')}`);
    if(runtime.landmarks.main!==1)throw new Error(`${url} must expose exactly one main landmark`);
    if(runtime.landmarks.h1!==1)throw new Error(`${url} must expose exactly one h1`);
    if(mobile&&runtime.overflowX>4)throw new Error(`${url} overflows mobile viewport by ${runtime.overflowX}px`);
    const severe=consoleErrors.filter(x=>!/favicon|net::ERR_/i.test(x));
    if(pageErrors.length||severe.length)throw new Error(`${url} browser runtime errors: ${[...pageErrors,...severe].join(' | ')}`);
    const file=`${mobile?'mobile-':'desktop-'}${slug(url)}.png`;
    await page.screenshot({path:path.join(OUT,file),fullPage:true});
    return{url,finalUrl:final.pathname+final.search,status:response.status(),title:await page.title(),...metrics,...runtime,screenshot:file};
  }finally{
    page.off('console',onConsole);page.off('pageerror',onPageError);page.off('requestfailed',onRequestFailed);
  }
}

async function assertWorkflow(page,url,{owner=null,current=null,personal=false}={}){
  const response=await page.goto(`${BASE}${url}`,{waitUntil:'domcontentloaded',timeout:20000});
  assert(response&&response.status()<400,`${url} workflow page returned ${response?.status()}`);
  await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});
  const visiblePageNavigation=await page.locator('.content nav.workflowCardGrid,.content nav.operatorTabs,.content nav.coherenceSectionTabs,.content nav.coherenceSubTabs,.content section.coherenceOwnedTools').evaluateAll(nodes=>nodes.filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}).length);
  assert.equal(visiblePageNavigation,0,`${url} still renders ${visiblePageNavigation} page-body navigation surfaces`);
  assert.equal(await page.locator('.adminSubTab').count(),0,`${url} reintroduced a third rail level`);
  if(owner){
    const activeMain=(await page.locator('.adminTab.active').allTextContents()).map(x=>x.trim()).filter(Boolean);
    assert.deepStrictEqual(activeMain,[owner],`${url} must keep ${owner} active in the left rail: ${JSON.stringify(activeMain)}`);
  }
  if(current){
    const breadcrumb=String(await page.locator('.topBreadcrumb strong').textContent()).trim();
    assert.equal(breadcrumb,current,`${url} breadcrumb does not identify its current page`);
  }
  const topBarAdminLinks=(await page.locator('.topBarActions > a[href^="/admin"]').allTextContents()).map(x=>x.trim()).filter(Boolean);
  assert.deepStrictEqual(topBarAdminLinks,[],`${url} mixes page navigation/actions into the global top utility bar: ${JSON.stringify(topBarAdminLinks)}`);
  if(personal){
    const personalSubRows=await page.locator('.content nav.operatorTabs,.content nav.coherenceSubTabs').evaluateAll(nodes=>nodes.filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}).length);
    assert.equal(personalSubRows,0,`${url} must not reintroduce a personal-account subtab row`);
  }
}

async function safeMutationAudit(page){
  const forms=await page.locator('form').evaluateAll(forms=>forms.map(form=>({method:(form.getAttribute('method')||'get').toUpperCase(),action:new URL(form.action,location.href).pathname,hasCsrf:Boolean(form.querySelector('input[name="_csrf"]')),buttons:[...form.querySelectorAll('button')].map(b=>b.textContent.trim())})));
  for(const form of forms){if(form.method==='POST')assert(form.hasCsrf,`POST form ${form.action} is missing CSRF`);}
}

async function main(){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  const inventory={desktop:[],mobile:[],generatedAt:new Date().toISOString()};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();
    await login(page);
    const encryptedApiKey=encryptWithEnv('browser-api-key-2026','JELLYFIN_ENCRYPTION_KEY','jf1');
    const server=await pool.query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,location,allow_new_users,trial_enabled,paid_enabled,health_status,last_health_check) VALUES('Browser Jellyfin','browser-jellyfin','premium','http://127.0.0.1:8096',NULL,$1,TRUE,50,100,NULL,TRUE,TRUE,TRUE,'offline',NOW()) ON CONFLICT DO NOTHING RETURNING id`,[encryptedApiKey]);
    const serverId=server.rows[0]?.id||(await pool.query(`SELECT id FROM jellyfin_servers WHERE name='Browser Jellyfin' LIMIT 1`)).rows[0]?.id;
    let customer=(await pool.query(`SELECT id FROM customers ORDER BY created_at LIMIT 1`)).rows[0];
    if(!customer)customer=(await pool.query(`INSERT INTO customers(email,display_name) VALUES('browser-customer@example.invalid','Browser Customer') RETURNING id`)).rows[0];

    const seedUrls=['/admin','/admin/users','/admin/plans','/admin/servers','/admin/activity','/admin/provisioning','/admin/automation','/admin/backups','/admin/settings?section=general'];
    const queue=[...seedUrls],visited=new Set();
    while(queue.length&&visited.size<110){
      const url=queue.shift();
      if(visited.has(url))continue;
      visited.add(url);
      const result=await auditPage(page,url);
      inventory.desktop.push(result);
      if(result.nonHtml)continue;
      for(const link of result.links||[]){
        if(link.download)continue;
        const next=canonical(link.href);
        if(next&&!visited.has(next)&&!queue.includes(next))queue.push(next);
      }
    }

    await assertWorkflow(page,'/admin/profile',{personal:true});
    await assertWorkflow(page,'/admin/profile/notifications',{personal:true});
    await assertWorkflow(page,'/admin/security',{personal:true});
    for(const [url,current] of [
      ['/admin/settings/integrations','Connections'],
      ['/admin/notifications/preferences','Notifications'],
      ['/admin/notifications/email','Email infrastructure'],
      ['/admin/notifications','Email infrastructure'],
      ['/admin/request-users','Request service']
    ]) await assertWorkflow(page,url,{owner:'Connections',current});
    await assertWorkflow(page,'/admin/provisioning',{owner:'Provisioning',current:'Provisioning'});
    await assertWorkflow(page,'/admin/provisioning/drift',{owner:'Provisioning',current:'Access consistency'});
    await assertWorkflow(page,'/admin/provisioning/migrations',{owner:'Provisioning',current:'Customer moves'});
    const legacyRequestResponse=await page.goto(`${BASE}/admin/request-plan-policy`,{waitUntil:'domcontentloaded',timeout:20000});
    assert(legacyRequestResponse&&legacyRequestResponse.status()<400,'legacy Request limits URL must remain a safe compatibility redirect');
    assert.equal(new URL(page.url()).pathname,'/admin/plans','legacy Request limits URL must redirect to canonical Plans');
    assert.equal(String(await page.locator('.topBreadcrumb strong').textContent()).trim(),'Plans','legacy Request limits must land in Plans');
    assert.deepStrictEqual((await page.locator('.adminTab.active').allTextContents()).map(x=>x.trim()).filter(Boolean),['Plans'],'legacy Request limits must keep Plans active in the rail');
    assert(!(await page.locator('.operatorTabs').allTextContents()).join(' ').includes('Request limits'),'Request limits must not remain as a duplicate Plans workflow card');
    await assertWorkflow(page,'/admin/backups',{owner:'Backups',current:'Backups'});
    await assertWorkflow(page,'/admin/configuration',{owner:'Backups',current:'Configuration Transfer'});

    await page.setViewportSize({width:390,height:844});
    for(const url of ['/admin','/admin/users','/admin/plans','/admin/plans/new?type=stremio','/admin/provisioning','/admin/request-users','/admin/notifications/preferences','/admin/profile','/admin/profile/notifications','/admin/security','/admin/servers/operations','/admin/backups','/admin/billing','/admin/payments/transactions','/admin/payments/export','/admin/activity']){
      inventory.mobile.push(await auditPage(page,url,{mobile:true}));
    }

    await page.goto(`${BASE}/admin/activity`,{waitUntil:'domcontentloaded'});
    const drawerToggle=page.locator('[data-admin-mobile-nav-toggle]');
    assert.equal(await drawerToggle.count(),1,'mobile admin shell must expose one drawer toggle');
    assert.equal(await drawerToggle.getAttribute('aria-expanded'),'false','mobile drawer must start closed');
    await drawerToggle.click();
    assert.equal(await drawerToggle.getAttribute('aria-expanded'),'true','drawer toggle must expose its open state');
    assert(await page.locator('body.mobileNavLocked').count(),'opening the drawer must lock page scrolling');
    const serversSection=page.locator('details.navSection[data-nav-section="servers"]');
    assert.equal(await serversSection.count(),1,'mobile drawer must expose the canonical Servers section');
    if(!(await serversSection.getAttribute('open')))await serversSection.locator(':scope > summary').click();
    const serverDestinations=(await serversSection.locator('.adminTab').allTextContents()).map(value=>value.trim()).filter(Boolean);
    assert.deepStrictEqual(serverDestinations,['Jellyfin','Stremio','Playback'],'mobile Servers drawer destinations changed');
    assert.deepStrictEqual((await serversSection.locator('.adminTab.active').allTextContents()).map(value=>value.trim()).filter(Boolean),['Playback'],'Playback must remain the single active rail destination');
    assert.equal(await page.locator('.adminSubTab').count(),0,'mobile drawer must never render third-level destinations');
    await page.keyboard.press('Escape');
    assert.equal(await drawerToggle.getAttribute('aria-expanded'),'false','Escape must close the mobile drawer');
    assert.equal(await page.locator('body.mobileNavLocked').count(),0,'closing the drawer must release page scrolling');

    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${BASE}/admin/payments/export`,{waitUntil:'domcontentloaded'});
    for(const [action,suffix] of [
      ['/admin/payments/export/users','.csv'],
      ['/admin/payments/export/payments','.csv'],
      ['/admin/payments/export/transactions','.csv'],
      ['/admin/payments/export/bundle','.zip']
    ]){
      const form=page.locator(`form[action="${action}"]`);
      assert.equal(await form.count(),1,`${action} export form must exist`);
      const [download]=await Promise.all([page.waitForEvent('download'),form.locator('button[type="submit"]').click()]);
      assert(download.suggestedFilename().endsWith(suffix),`${action} must download ${suffix}`);
      const stream=await download.createReadStream();
      let bytes=0; for await(const chunk of stream)bytes+=chunk.length;
      assert(bytes>0,`${action} download must not be empty`);
    }
    inventory.summary={desktopPages:inventory.desktop.length,mobilePages:inventory.mobile.length,uniqueForms:unique(inventory.desktop.flatMap(x=>(x.forms||[]).map(f=>`${f.method} ${f.action}`))).length,uniqueButtons:unique(inventory.desktop.flatMap(x=>x.buttons||[])).length};
    fs.writeFileSync(path.join(OUT,'inventory.json'),JSON.stringify(inventory,null,2));
    console.log(`admin browser regression: ok — ${inventory.summary.desktopPages} desktop pages, ${inventory.summary.mobilePages} mobile pages, ${inventory.summary.uniqueForms} form targets, ${inventory.summary.uniqueButtons} visible button labels`);
    await context.close();
  }catch(error){
    inventory.failure=error.stack||String(error);
    fs.writeFileSync(path.join(OUT,'inventory.json'),JSON.stringify(inventory,null,2));
    throw error;
  }finally{await browser.close();await pool.end();}
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});