#!/usr/bin/env python3
from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one occurrence, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# Keep /admin/libraries for direct/manual compatibility, but it is a utility
# rather than a durable navigation destination.
replace_once(
    'src/platform/admin-nav.js',
    "const SIDEBAR_EXCLUDED_CHILDREN=new Set(['search','my-profile','my-notifications','my-security']);",
    "const SIDEBAR_EXCLUDED_CHILDREN=new Set(['search','libraries','my-profile','my-notifications','my-security']);"
)

# Enrich the canonical page arrays with a non-enumerable children property.
# Modern pages continue using childPages(); legacy EJS pages receive the exact
# same registry through the already-existing adminNavGroups local.
replace_once(
    'src/platform/admin-nav.js',
    "function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}\nmodule.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,workflowParentPage,workflowPages,childPages,landingFor,SIDEBAR_EXCLUDED_CHILDREN};",
    "function landingFor(group){return group?.pages?.[0]?.[2]||'/admin';}\nfor(const group of groups){for(const page of group.pages){if(!Object.prototype.hasOwnProperty.call(page,'children'))Object.defineProperty(page,'children',{value:Object.freeze(childPages(page[0])),enumerable:false});}}\nmodule.exports={groups,hiddenPages,aliases,activeKey,sidebarKey,groupFor,workflowParentPage,workflowPages,childPages,landingFor,SIDEBAR_EXCLUDED_CHILDREN};"
)

p = Path('views/admin/_nav.ejs')
text = p.read_text()
text = text.replace(
    "    automation:'<path d=\"M18 8a6 6 0 1 0 1.76 4.24\"/><path d=\"M18 3v5h5\"/><path d=\"m13 9-3 4h4l-3 4\"/>',\n",
    "    stremio:'<path d=\"m9 7 8 5-8 5V7Z\"/><path d=\"M4 5.5v13\"/><path d=\"M20 5.5v13\"/>',\n    automation:'<path d=\"M18 8a6 6 0 1 0 1.76 4.24\"/><path d=\"M18 3v5h5\"/><path d=\"m13 9-3 4h4l-3 4\"/>',\n",
    1
)
old = '''        <summary class="navSectionLabel"><span class="navSectionHome"><span class="navIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><%- iconPaths[group.key]||iconPaths.dashboard %></svg></span><span><%= group.label %></span></span><span class="navChevron" aria-hidden="true">⌄</span></summary>
        <div class="navSectionPages"><% group.pages.forEach(function(child){ %><a class="adminTab <%= currentSidebarKey===child[0]?'active':'' %>" href="<%= child[2] %>" title="Open <%= child[1] %>"><%= child[1] %></a><% }); %></div>'''
new = '''        <summary class="navSectionLabel"><span class="navSectionHome"><span class="navIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><%- iconPaths[group.key==='jellyfin'?'servers':group.key==='resellers'?'people':group.key]||iconPaths.dashboard %></svg></span><span><%= group.label %></span></span><span class="navChevron" aria-hidden="true">⌄</span></summary>
        <div class="navSectionPages">
          <% group.pages.forEach(function(child){ const children=Array.isArray(child.children)?child.children:[]; const parentSelected=currentSidebarKey===child[0]; const exactSelected=currentKey===child[0]; %>
            <div class="adminTabGroup">
              <a class="adminTab <%= parentSelected?'active':'' %>" href="<%= child[2] %>" title="Open <%= child[1] %>" <%= exactSelected?'aria-current="page"':'' %>><%= child[1] %></a>
              <% if(children.length){ %><div class="adminTabChildren" aria-label="<%= child[1] %> tools">
                <% children.forEach(function(grandchild){ const selected=currentKey===grandchild[0]; %><a class="adminSubTab <%= selected?'active':'' %>" href="<%= grandchild[2] %>" title="Open <%= grandchild[1] %>" <%= selected?'aria-current="page"':'' %>><%= grandchild[1] %></a><% }); %>
              </div><% } %>
            </div>
          <% }); %>
        </div>'''
if old not in text:
    raise SystemExit('views/admin/_nav.ejs: expected navigation block not found')
p.write_text(text.replace(old, new, 1))

# Frankfurter's current no-key public API is api.frankfurter.dev/v2. The prior
# .app URL may redirect, while CAPTAiNFiN intentionally rejects redirects.
replace_once(
    'src/platform/reporting-currency.js',
    "      const response=await fetch('https://api.frankfurter.app/latest?from=GBP&to=USD,EUR',{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});\n      if(!response.ok)throw new Error(`FX HTTP ${response.status}`);const body=await response.json(),usd=Number(body?.rates?.USD),eur=Number(body?.rates?.EUR);if(!Number.isFinite(usd)||usd<=0||!Number.isFinite(eur)||eur<=0)throw new Error('FX response missing GBP rates');\n",
    "      const response=await fetch('https://api.frankfurter.dev/v2/rates?base=GBP&quotes=USD,EUR',{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});\n      if(!response.ok)throw new Error(`FX HTTP ${response.status}`);\n      const body=await response.json(),rows=Array.isArray(body)?body:[],rates=Object.fromEntries(rows.map(row=>[String(row?.quote||'').toUpperCase(),Number(row?.rate)])),usd=rates.USD,eur=rates.EUR;\n      if(!Number.isFinite(usd)||usd<=0||!Number.isFinite(eur)||eur<=0)throw new Error('FX response missing GBP quotes');\n"
)

# Static regression for navigation parity and removed Libraries navigation.
p = Path('scripts/admin-accessibility-mobile-smoke.js')
text = p.read_text()
anchor = "const sidebar=read('public/js/admin-sidebar-nav.js');\n"
addition = """const legacyNav=read('views/admin/_nav.ejs');
const navRegistry=require('../src/platform/admin-nav');
assert(legacyNav.includes('Array.isArray(child.children)')&&legacyNav.includes('class=\"adminSubTab'),'legacy EJS sidebar must render canonical nested destinations');
assert(navRegistry.childPages('activity').some(page=>page[0]==='inactivity-policy'),'Playback must retain its Free-user inactivity rules child destination');
assert(!navRegistry.childPages('servers').some(page=>page[0]==='libraries'),'Libraries scan utility must not appear as permanent sidebar navigation');
assert(navRegistry.groups.find(group=>group.key==='jellyfin').pages.find(page=>page[0]==='activity').children.some(page=>page[0]==='inactivity-policy'),'legacy nav group data must carry Playback nested destinations');
"""
if anchor not in text:
    raise SystemExit('admin-accessibility-mobile-smoke.js: sidebar anchor missing')
p.write_text(text.replace(anchor, addition + anchor, 1))

# Static regression for the current external FX contract.
p = Path('scripts/storefront-currency-integrity-smoke.js')
text = p.read_text()
anchor = "assert(reporting.includes(\"'admin.portal_currency.update'\"),'Master currency changes must be audited');\n"
addition = """assert(reporting.includes('https://api.frankfurter.dev/v2/rates?base=GBP&quotes=USD,EUR'),'FX refresh must use Frankfurter current public v2 endpoint');
assert(!reporting.includes('api.frankfurter.app'),'FX refresh must not use Frankfurter retired redirecting .app endpoint');
assert(reporting.includes('Array.isArray(body)')&&reporting.includes('row?.quote')&&reporting.includes('row?.rate'),'FX refresh must parse Frankfurter v2 flat rate rows');
"""
if anchor not in text:
    raise SystemExit('storefront-currency-integrity-smoke.js: reporting anchor missing')
p.write_text(text.replace(anchor, addition + anchor, 1))

# Real Chromium regression: Playback is an EJS-rendered page and was the path
# where the nested menu disappeared on phones.
p = Path('tests/admin-browser-regression.js')
text = p.read_text()
old = "'/admin/backups','/admin/billing','/admin/payments/transactions','/admin/payments/export']"
new = "'/admin/backups','/admin/billing','/admin/payments/transactions','/admin/payments/export','/admin/activity']"
if old not in text:
    raise SystemExit('admin-browser-regression.js: mobile inventory anchor missing')
text = text.replace(old, new, 1)
anchor = "    // Export endpoints are POST + CSRF downloads. Exercise all four against the\n"
addition = """    await page.goto(`${BASE}/admin/activity`,{waitUntil:'domcontentloaded'});
    await page.locator('[data-admin-mobile-nav-toggle]').click();
    const jellyfinSection=page.locator('details.navSection[data-nav-section=\"jellyfin\"]');
    if(!(await jellyfinSection.getAttribute('open')))await jellyfinSection.locator(':scope > summary').click();
    const jellyfinNested=(await jellyfinSection.locator('.adminSubTab').allTextContents()).map(value=>value.trim()).filter(Boolean);
    assert(jellyfinNested.includes('Free-user inactivity rules'),`Playback mobile drawer lost its nested tools: ${JSON.stringify(jellyfinNested)}`);
    assert(!jellyfinNested.includes('Libraries'),'Libraries utility must not reappear in the mobile drawer');

"""
if anchor not in text:
    raise SystemExit('admin-browser-regression.js: export anchor missing')
p.write_text(text.replace(anchor, addition + anchor, 1))
