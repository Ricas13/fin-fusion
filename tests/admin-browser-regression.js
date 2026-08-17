'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const {chromium}=require('playwright');

const BASE=String(process.env.BROWSER_BASE_URL||'http://127.0.0.1:3030').replace(/\/$/,'');
const USER=process.env.BROWSER_ADMIN_USERNAME||'browseradmin';
const PASSWORD=process.env.BROWSER_ADMIN_PASSWORD||'BrowserAuditPass!2026';
const OUT=path.join(process.cwd(),'test-results','admin-browser');
fs.mkdirSync(OUT,{recursive:true});

const forced=[
  '/admin','/admin/attention','/admin/search','/admin/events',
  '/admin/users','/admin/activity',
  '/admin/servers','/admin/libraries','/admin/servers/operations',
  '/admin/commerce','/admin/plans','/admin/plans/new?type=stremio','/admin/payments','/admin/discounts','/admin/referrals',
  '/admin/provisioning','/admin/request-users','/admin/request-plan-policy','/admin/provisioning/migrations','/admin/provisioning/drift','/admin/automation',
  '/admin/settings?section=general','/admin/profile','/admin/profile/notifications','/admin/security',
  '/admin/notifications/preferences','/admin/notifications/email','/admin/notifications',
  '/admin/settings/branding','/admin/settings?section=integrations','/admin/settings?section=security',
  '/admin/backups','/admin/configuration'
];

function slug(value){return String(value).replace(/^https?:\/\/[^/]+/,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,110)||'admin';}
function canonical(href){
  try{
    const u=new URL(href,BASE);
    if(u.origin!==new URL(BASE).origin||!u.pathname.startsWith('/admin'))return null;
    if(/\/(?:export|download)(?:\/|$)/i.test(u.pathname))return null;
    if(u.pathname==='/admin/preview')return null;
    u.hash='';
    return `${u.pathname}${u.search}`;
  }catch{return null;}
}
function unique(values){return [...new Set(values.filter(Boolean))];}
function fail(message,detail){const e=new Error(detail?`${message}: ${detail}`:message);e.auditFailure=true;throw e;}

async function signIn(page){
  const response=await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
  assert(response&&response.status()<400,`Login page returned ${response?.status()}`);
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(url=>url.pathname.startsWith('/admin'),{timeout:15000}),
    page.getByRole('button',{name:'Sign in'}).click()
  ]);
  if(!new URL(page.url()).pathname.startsWith('/admin'))fail('Admin login did not reach the admin area',page.url());
}

async function browserMetrics(page){
  return page.evaluate(()=>{
    const root=document.documentElement;
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
    const directCards=grid=>[...grid.children].filter(el=>el.classList.contains('analyticsCard')&&visible(el));
    const gridCoverage=[...document.querySelectorAll('.analyticsGrid')].filter(visible).map(grid=>{
      const rect=grid.getBoundingClientRect(),cards=directCards(grid),rows=[];
      for(const card of cards){
        const r=card.getBoundingClientRect();
        let row=rows.find(x=>Math.abs(x.top-r.top)<8);
        if(!row){row={top:r.top,width:0,cards:0};rows.push(row);}
        row.width+=r.width;row.cards++;
      }
      return{className:grid.className,width:rect.width,rows:rows.map(row=>({cards:row.cards,coverage:rect.width?row.width/rect.width:1}))};
    });
    return{
      viewport:{width:innerWidth,height:innerHeight},
      documentWidth:root.scrollWidth,
      horizontalOverflow:Math.max(0,root.scrollWidth-root.clientWidth),
      h1:[...document.querySelectorAll('h1')].filter(visible).map(x=>x.textContent.trim()),
      activeSidebar:[...document.querySelectorAll('.adminTab.active')].filter(visible).map(x=>x.textContent.trim()),
      workflowTabs:[...document.querySelectorAll('.operatorTabs a')].filter(visible).map(x=>x.textContent.trim()),
      forms:[...document.forms].filter(visible).map(f=>({method:(f.method||'get').toUpperCase(),action:f.getAttribute('action')||''})),
      buttons:[...document.querySelectorAll('button,.button')].filter(visible).map(x=>x.textContent.trim()).filter(Boolean),
      links:[...document.querySelectorAll('a[href]')].filter(visible).map(a=>({href:a.href,text:a.textContent.trim(),target:a.target,download:a.hasAttribute('download')})),
      analyticsCards:[...document.querySelectorAll('.analyticsCard')].filter(visible).map(x=>x.querySelector('h2')?.textContent.trim()||''),
      gridCoverage
    };
  });
}

async function auditPage(page,url,{mobile=false}={}){
  const runtime={consoleErrors:[],pageErrors:[],requestFailures:[]};
  const onConsole=msg=>{if(msg.type()==='error')runtime.consoleErrors.push(msg.text());};
  const onPageError=err=>runtime.pageErrors.push(err.message);
  const onRequestFailed=req=>{if(req.resourceType()==='document'||req.resourceType()==='script'||req.resourceType()==='stylesheet')runtime.requestFailures.push(`${req.resourceType()}: ${req.url()} :: ${req.failure()?.errorText||'failed'}`);};
  page.on('console',onConsole);page.on('pageerror',onPageError);page.on('requestfailed',onRequestFailed);
  let response;
  try{
    response=await page.goto(`${BASE}${url}`,{waitUntil:'networkidle',timeout:20000});
    if(!response)fail('Navigation produced no HTTP response',url);
    if(response.status()>=400)fail('Admin page returned an error status',`${url} -> ${response.status()}`);
    const final=new URL(page.url());
    if(final.pathname==='/login'||final.pathname.startsWith('/auth/'))fail('Admin page unexpectedly returned to authentication',`${url} -> ${final.pathname}`);
    const type=String(response.headers()['content-type']||'');
    if(!type.includes('text/html'))return{url,finalUrl:final.pathname+final.search,status:response.status(),contentType:type,nonHtml:true};
    const bodyText=await page.locator('body').innerText();
    if(/(^|\n)Not found(\n|$)/i.test(bodyText)||bodyText.trim()==='Not found')fail('Visible admin page rendered Not found',url);
    if(/Request failed(?:\s*\(\d+\))?\.?$/im.test(bodyText))fail('Visible admin page rendered generic Request failed',url);
    const metrics=await browserMetrics(page);
    if(metrics.h1.length!==1)fail('Admin page must have exactly one visible H1',`${url} has ${metrics.h1.length}`);
    if(metrics.horizontalOverflow>4)fail('Page has document-level horizontal overflow',`${url} overflows by ${metrics.horizontalOverflow}px at ${metrics.viewport.width}px`);
    if(runtime.pageErrors.length)fail('Browser page error',`${url}: ${runtime.pageErrors.join(' | ')}`);
    if(runtime.consoleErrors.length)fail('Browser console error',`${url}: ${runtime.consoleErrors.join(' | ')}`);
    if(runtime.requestFailures.length)fail('Critical browser request failed',`${url}: ${runtime.requestFailures.join(' | ')}`);
    if(url==='/admin'&&!mobile){
      for(const grid of metrics.gridCoverage){
        for(const [index,row] of grid.rows.entries()){
          if(row.coverage<0.88)fail('Dashboard card row leaves excessive empty space',`${grid.className} row ${index+1} covers ${(row.coverage*100).toFixed(0)}%`);
        }
      }
    }
    const file=`${mobile?'mobile-':'desktop-'}${slug(url)}.png`;
    await page.screenshot({path:path.join(OUT,file),fullPage:true});
    return{url,finalUrl:final.pathname+final.search,status:response.status(),title:await page.title(),...metrics,...runtime,screenshot:file};
  }finally{
    page.off('console',onConsole);page.off('pageerror',onPageError);page.off('requestfailed',onRequestFailed);
  }
}

async function assertWorkflow(page,url,expected,activeExpected=null){
  await page.goto(`${BASE}${url}`,{waitUntil:'networkidle'});
  const tabs=await page.locator('.operatorTabs a').allTextContents();
  const clean=tabs.map(x=>x.trim()).filter(Boolean);
  assert.deepStrictEqual(clean,expected,`${url} workflow tabs changed: ${JSON.stringify(clean)}`);
  if(activeExpected){
    const active=(await page.locator('.operatorTabs a.active').allTextContents()).map(x=>x.trim()).filter(Boolean);
    assert.deepStrictEqual(active,[activeExpected],`${url} active workflow tab changed: ${JSON.stringify(active)}`);
    const breadcrumb=String(await page.locator('.topBreadcrumb strong').textContent()).trim();
    assert.equal(breadcrumb,activeExpected,`${url} breadcrumb does not match its workflow page`);
    const siblingLinks=(await page.locator('.topBarActions a[href^="/admin"]').allTextContents()).map(x=>x.trim()).filter(Boolean);
    assert.deepStrictEqual(siblingLinks,[],`${url} mixes sibling-page navigation into the top-right action area: ${JSON.stringify(siblingLinks)}`);
  }
}

async function safeMutationAudit(page){
  await page.goto(`${BASE}/admin/profile`,{waitUntil:'networkidle'});
  const email='browser-audit@example.invalid';
  const emailForm=page.locator('form[action="/admin/profile/email"]');
  assert.equal(await emailForm.count(),1,'My Profile email form is missing');
  await emailForm.locator('input[name="email"]').fill(email);
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle',timeout:15000}),emailForm.getByRole('button',{name:'Save email'}).click()]);
  assert(!((await page.locator('body').innerText()).includes('Not found')),'Saving My Profile email routed to Not found');
  assert((await page.locator('input[name="email"]').inputValue())===email,'Saved administrator email did not round-trip');

  const currencyForm=page.locator('form[action="/admin/profile/currency"]');
  assert.equal(await currencyForm.count(),1,'My Profile reporting currency form is missing');
  await currencyForm.locator('select[name="currency"]').selectOption('EUR');
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle',timeout:15000}),currencyForm.getByRole('button',{name:'Save currency'}).click()]);
  assert.equal(await page.locator('form[action="/admin/profile/currency"] select[name="currency"]').inputValue(),'EUR','Saved reporting currency did not round-trip');
}

async function fillStremioPlan(form,{code='browser-stremio-addon',name='Stremio Addon'}={}){
  await form.locator('select[name="serviceType"]').selectOption('stremio');
  await form.locator('input[name="code"]').fill(code);
  await form.locator('input[name="name"]').fill(name);
  await form.locator('textarea[name="description"]').fill('Access to a stremio addon');
  // Direct customer plans and monthly reseller plans are configured separately.
  assert.equal(await form.locator('select[name="audience"]').count(),0,'Customer plan creation must not expose reseller audience routing');
  await form.locator('input[name="price"]').fill('6');
  await form.locator('select[name="currency"]').selectOption('USD');
  await form.locator('input[name="capacityLimit"]').fill('20');
  await form.locator('select[name="billingInterval"]').selectOption('month');
  await form.locator('input[name="streams"]').fill('1');
}

async function planCreationAudit(page){
  await page.goto(`${BASE}/admin/plans/new?type=stremio`,{waitUntil:'networkidle'});
  let form=page.locator('form[data-plan-create-v2]');
  assert.equal(await form.count(),1,'Canonical V2 plan creation form is not owning /admin/plans/new');
  await fillStremioPlan(form);
  await Promise.all([
    page.waitForURL(url=>/\/admin\/plans\/[^/]+\/delivery$/.test(url.pathname),{timeout:15000}),
    form.getByRole('button',{name:'Create plan'}).click()
  ]);
  const createdUrl=new URL(page.url());
  assert(/\/admin\/plans\/[^/]+\/delivery$/.test(createdUrl.pathname),'Valid Stremio creation did not continue to Delivery');
  assert(!/Request failed/i.test(await page.locator('body').innerText()),'Valid Stremio creation surfaced a generic request failure');

  await page.goto(`${BASE}/admin/plans/new?type=stremio`,{waitUntil:'networkidle'});
  form=page.locator('form[data-plan-create-v2]');
  await fillStremioPlan(form,{name:'Duplicate Stremio Addon'});
  await form.getByRole('button',{name:'Create plan'}).click();
  const error=page.locator('.formSubmitError,[data-form-error]').first();
  await error.waitFor({state:'visible',timeout:10000});
  const message=(await error.textContent()||'').trim();
  assert(/already exists/i.test(message),`Duplicate plan did not surface an actionable error: ${message}`);
  assert(!/Request failed\s*\(400\)/i.test(message),'Duplicate plan error was masked as Request failed (400)');
}

async function personalNotificationsAudit(page){
  await page.goto(`${BASE}/admin/profile/notifications`,{waitUntil:'networkidle'});
  const activeSidebar=(await page.locator('.adminTab.active').allTextContents()).map(x=>x.trim()).filter(Boolean);
  assert.deepStrictEqual(activeSidebar,['My Profile'],`Personal notifications should belong to My Profile, got ${JSON.stringify(activeSidebar)}`);
  const breadcrumb=String(await page.locator('.topBreadcrumb strong').textContent()).trim();
  assert.equal(breadcrumb,'My Notifications','Personal notification breadcrumb has the wrong owner');
  const body=await page.locator('body').innerText();
  assert(!/Preferred dashboard\/reporting currency/i.test(body),'Reporting currency is duplicated on the Notifications tab');
  assert(!/Profile & reporting/i.test(body),'Profile settings are duplicated on the Notifications tab');
  const groups=await page.locator('details.notificationEventGroup').count();
  assert(groups>=3,`Personal event routing is not grouped by operator job (${groups} group(s))`);
  assert.equal(await page.locator('section').filter({hasText:'Your delivery channels'}).count(),1,'Personal delivery readiness is missing');
}

async function main(){
  const browser=await chromium.launch({headless:true});
  const inventory={generatedAt:new Date().toISOString(),desktop:[],mobile:[],summary:{}};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();
    await signIn(page);
    await safeMutationAudit(page);
    await planCreationAudit(page);
    await personalNotificationsAudit(page);

    const sidebar=await page.locator('.adminTab[href^="/admin"]').evaluateAll(nodes=>nodes.map(a=>a.getAttribute('href')));
    const queue=unique([...forced,...sidebar].map(canonical));
    const visited=new Set();
    while(queue.length&&visited.size<160){
      const url=queue.shift();
      if(!url||visited.has(url))continue;
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
    for(const url of ['/admin/notifications/preferences','/admin/notifications/email','/admin/notifications']){
      await assertWorkflow(page,url,['Global notifications','Email infrastructure','Delivery health']);
    }
    const provisioningTabs=['Provisioning','Server migrations','Policy drift'];
    for(const [url,active] of [
      ['/admin/provisioning','Provisioning'],
      ['/admin/provisioning/migrations','Server migrations'],
      ['/admin/provisioning/drift','Policy drift']
    ]) await assertWorkflow(page,url,provisioningTabs,active);
    const integrationTabs=['Integrations','Request service','Plan limits'];
    for(const [url,active] of [
      ['/admin/settings?section=integrations','Integrations'],
      ['/admin/request-users','Request service'],
      ['/admin/request-plan-policy','Plan limits']
    ]) await assertWorkflow(page,url,integrationTabs,active);
    await assertWorkflow(page,'/admin/backups',['Database backups','Configuration transfer']);
    await assertWorkflow(page,'/admin/configuration',['Database backups','Configuration transfer']);

    await page.setViewportSize({width:390,height:844});
    for(const url of ['/admin','/admin/users','/admin/plans','/admin/plans/new?type=stremio','/admin/provisioning','/admin/request-users','/admin/request-plan-policy','/admin/notifications/preferences','/admin/profile','/admin/profile/notifications','/admin/security','/admin/servers/operations','/admin/backups']){
      inventory.mobile.push(await auditPage(page,url,{mobile:true}));
    }

    inventory.summary={desktopPages:inventory.desktop.length,mobilePages:inventory.mobile.length,uniqueForms:unique(inventory.desktop.flatMap(x=>(x.forms||[]).map(f=>`${f.method} ${f.action}`))).length,uniqueButtons:unique(inventory.desktop.flatMap(x=>x.buttons||[])).length};
    fs.writeFileSync(path.join(OUT,'inventory.json'),JSON.stringify(inventory,null,2));
    console.log(`admin browser regression: ok — ${inventory.summary.desktopPages} desktop pages, ${inventory.summary.mobilePages} mobile pages, ${inventory.summary.uniqueForms} form targets, ${inventory.summary.uniqueButtons} visible button labels`);
    await context.close();
  }catch(error){
    inventory.failure=error.stack||String(error);
    fs.writeFileSync(path.join(OUT,'inventory.json'),JSON.stringify(inventory,null,2));
    throw error;
  }finally{await browser.close();}
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});
