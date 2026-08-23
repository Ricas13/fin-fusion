'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const { chromium }=require('playwright');
const {Pool}=require('pg');
const {encryptWithEnv}=require('../src/security/secret-envelope');

const BASE=process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030';
const ADMIN_USERNAME=process.env.BROWSER_ADMIN_USERNAME||process.env.ADMIN_USERNAME||'browseradmin';
const ADMIN_PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||process.env.ADMIN_PASSWORD||'BrowserAuditPass!2026';
const OUT=path.join(__dirname,'..','test-results','admin-browser');
fs.mkdirSync(OUT,{recursive:true});

function slug(value){return String(value||'').replace(/^https?:\/\/[^/]+/,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,120)||'root';}
function canonical(href){
  try{
    const url=new URL(href,BASE);
    if(url.origin!==new URL(BASE).origin)return null;
    if(!url.pathname.startsWith('/admin'))return null;
    if(url.pathname.includes('/logout'))return null;
    return `${url.pathname}${url.search}`;
  }catch{return null;}
}

async function login(page){
  await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
  await page.fill('input[name="username"]',ADMIN_USERNAME);
  await page.fill('input[name="password"]',ADMIN_PASSWORD);
  await Promise.all([
    page.waitForNavigation({waitUntil:'domcontentloaded'}),
    page.click('button[type="submit"]')
  ]);
  assert(new URL(page.url()).pathname.startsWith('/admin'),'Browser audit could not authenticate as admin');
}

async function pageRuntimeMetrics(page){
  return page.evaluate(()=>({
    horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    emptyHrefCount:[...document.querySelectorAll('a[href]')].filter(a=>!String(a.getAttribute('href')||'').trim()).length,
    missingButtonTypeCount:[...document.querySelectorAll('form button')].filter(b=>!b.getAttribute('type')&&!b.getAttribute('formaction')).length,
    duplicateIds:(()=>{const seen=new Set(),dups=[];for(const el of document.querySelectorAll('[id]')){if(seen.has(el.id))dups.push(el.id);seen.add(el.id)}return [...new Set(dups)]})(),
    navActiveCount:document.querySelectorAll('.navLink.active,.navSubLink.active').length,
    title:document.title,
    h1:[...document.querySelectorAll('h1')].map(x=>x.textContent.trim()).filter(Boolean)
  }));
}

async function auditPage(page,url,{mobile=false}={}){
  const consoleErrors=[],pageErrors=[],requestFailures=[];
  const onConsole=msg=>{if(msg.type()==='error')consoleErrors.push(msg.text())};
  const onPageError=err=>pageErrors.push(err.message);
  const onRequestFailed=req=>requestFailures.push(`${req.method()} ${req.url()} ${req.failure()?.errorText||''}`);
  page.on('console',onConsole);page.on('pageerror',onPageError);page.on('requestfailed',onRequestFailed);
  try{
    const response=await page.goto(`${BASE}${url}`,{waitUntil:'domcontentloaded',timeout:20000});
    const final=new URL(page.url());
    const contentType=response?.headers()['content-type']||'';
    if(!contentType.includes('text/html'))return{url,finalUrl:final.pathname+final.search,status:response?.status()||0,nonHtml:true};
    await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});
    const metrics=await pageRuntimeMetrics(page);
    assert(metrics.horizontalOverflow<=3,`${url} has horizontal overflow of ${metrics.horizontalOverflow}px`);
    assert.equal(metrics.emptyHrefCount,0,`${url} contains empty href links`);
    assert.deepStrictEqual(metrics.duplicateIds,[],`${url} contains duplicate IDs: ${metrics.duplicateIds.join(', ')}`);
    const runtime={consoleErrors,pageErrors,requestFailures};
    const severe=consoleErrors.filter(x=>!/favicon|net::ERR_/i.test(x));
    if(pageErrors.length||severe.length)throw new Error(`${url} browser runtime errors: ${[...pageErrors,...severe].join(' | ')}`);
    const file=`${mobile?'mobile-':'desktop-'}${slug(url)}.png`;
    await page.screenshot({path:path.join(OUT,file),fullPage:true});
    return{url,finalUrl:final.pathname+final.search,status:response.status(),title:await page.title(),...metrics,...runtime,screenshot:file};
  }finally{
    page.off('console',onConsole);page.off('pageerror',onPageError);page.off('requestfailed',onRequestFailed);
  }
}

async function assertWorkflow(page,url,expected,activeExpected=null){
  const response=await page.goto(`${BASE}${url}`,{waitUntil:'domcontentloaded',timeout:20000});
  assert(response&&response.status()<400,`${url} workflow page returned ${response?.status()}`);
  await page.waitForLoadState('load',{timeout:10000}).catch(()=>{});
  // Workflow navigation is card-based now. Read the card heading rather than
  // concatenating the eyebrow, description and action copy into its label.
  const clean=(await page.locator('.operatorTabs a strong').allTextContents()).map(x=>x.trim()).filter(Boolean);
  assert.deepStrictEqual(clean,expected,`${url} workflow cards changed: ${JSON.stringify(clean)}`);
  if(activeExpected){
    const active=(await page.locator('.operatorTabs a.active strong').allTextContents()).map(x=>x.trim()).filter(Boolean);
    assert.deepStrictEqual(active,[activeExpected],`${url} active workflow card changed: ${JSON.stringify(active)}`);
    const breadcrumb=String(await page.locator('.topBreadcrumb strong').textContent()).trim();
    assert.equal(breadcrumb,activeExpected,`${url} breadcrumb does not match its workflow page`);
    const siblingLinks=(await page.locator('.topBarActions > a[href^="/admin"]').allTextContents()).map(x=>x.trim()).filter(Boolean);
    assert.deepStrictEqual(siblingLinks,[],`${url} mixes sibling-page navigation into the top-right action area: ${JSON.stringify(siblingLinks)}`);
  }
}

async function safeMutationAudit(page){
  const forms=await page.locator('form').evaluateAll(forms=>forms.map(form=>({method:(form.method||'get').toUpperCase(),action:new URL(form.action,location.href).pathname,hasCsrf:Boolean(form.querySelector('input[name="_csrf"]')),buttons:[...form.querySelectorAll('button')].map(b=>b.textContent.trim())})));
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

    // Seed representative records using the same encrypted credential contract
    // as the live server registry so the browser harness cannot regress to the
    // retired plaintext api_key schema.
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

    const profileTabs=['Profile','Notifications','Security'];
    await assertWorkflow(page,'/admin/profile',profileTabs);
    await assertWorkflow(page,'/admin/profile/notifications',profileTabs);
    await assertWorkflow(page,'/admin/security',profileTabs);

    const connectionTabs=['Connections','Notifications','Email infrastructure','Request service'];
    for(const [url,active] of [
      ['/admin/settings/integrations','Connections'],
      ['/admin/notifications/preferences','Notifications'],
      ['/admin/notifications/email','Email infrastructure'],
      ['/admin/notifications','Email infrastructure'],
      ['/admin/request-users','Request service']
    ]) await assertWorkflow(page,url,connectionTabs,active);

    const provisioningTabs=['Provisioning','Customer moves','Access consistency'];
    for(const [url,active] of [
      ['/admin/provisioning','Provisioning'],
      ['/admin/provisioning/migrations','Customer moves'],
      ['/admin/provisioning/drift','Access consistency']
    ]) await assertWorkflow(page,url,provisioningTabs,active);

    const legacyRequestResponse=await page.goto(`${BASE}/admin/request-plan-policy`,{waitUntil:'domcontentloaded',timeout:20000});
    assert(legacyRequestResponse&&legacyRequestResponse.status()<400,'legacy Request limits URL must remain a safe compatibility redirect');
    assert.equal(new URL(page.url()).pathname,'/admin/plans','legacy Request limits URL must redirect to canonical Plans');
    assert.equal(String(await page.locator('.topBreadcrumb strong').textContent()).trim(),'Plans & Storefront','legacy Request limits must land in Plans & Storefront');
    assert(!(await page.locator('.operatorTabs').allTextContents()).join(' ').includes('Request limits'),'Request limits must not remain as a duplicate Plans workflow card');
    await assertWorkflow(page,'/admin/backups',['Database backups','Configuration transfer']);

    await safeMutationAudit(page);
    fs.writeFileSync(path.join(OUT,'inventory.json'),JSON.stringify(inventory,null,2));
    await context.close();
  }finally{
    await browser.close();
    await pool.end();
  }
}

main().catch(error=>{console.error(error);process.exit(1)});
