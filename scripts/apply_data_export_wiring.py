from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def patch(path, old, new):
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'expected source not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))

# Preserve actual numeric CSV values (including negative accounting values) as
# numeric cells while still neutralising formula-like user-controlled strings.
patch('src/payments/data-export.js',
"function excelSafe(value) {\n    const raw = text(value);\n    return /^[=+\\-@]/.test(raw) ? `'${raw}` : raw;\n}",
"function excelSafe(value) {\n    const raw = text(value);\n    if (/^[+-]?\\d+(?:\\.\\d+)?$/.test(raw)) return raw;\n    return /^[=+\\-@]/.test(raw) ? `'${raw}` : raw;\n}\n")

patch('src/platform/admin-nav.js',
"  transactions:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['transactions','Transactions','/admin/payments/transactions'])}),\n",
"  transactions:Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['transactions','Transactions','/admin/payments/transactions'])}),\n  'data-export':Object.freeze({groupKey:'commerce',parentKey:'payments',page:Object.freeze(['data-export','Export data','/admin/payments/export'])}),\n")

patch('src/platform/admin-route-composition.js',
"const { createAdminTransactionsRouter } = require('./admin-transactions');\n",
"const { createAdminTransactionsRouter } = require('./admin-transactions');\nconst { createAdminDataExportRouter } = require('./admin-data-export');\n")
patch('src/platform/admin-route-composition.js',
"  app.use(createAdminTransactionsRouter());\n",
"  app.use(createAdminTransactionsRouter());\n  app.use(createAdminDataExportRouter());\n")

# Make the import/export relationship discoverable in both directions.
patch('src/platform/admin-legacy-customer-import.js',
"<a class=\"button secondary btn-sm\" href=\"/admin/provider-mappings\">Provider mappings</a>",
"<div class=\"buttonRow\"><a class=\"button secondary btn-sm\" href=\"/admin/payments/export\">Export data</a><a class=\"button secondary btn-sm\" href=\"/admin/provider-mappings\">Provider mappings</a></div>")

nav_test = 'scripts/admin-navigation-coherence-smoke.js'
patch(nav_test,
"['Billing','Transactions','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']",
"['Billing','Transactions','Export data','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']")
patch(nav_test,
"assert.strictEqual(nav.sidebarKey('transactions'),'payments');\n",
"assert.strictEqual(nav.sidebarKey('transactions'),'payments');\nassert.strictEqual(nav.sidebarKey('data-export'),'payments');\n")
patch(nav_test,
"expenseHeader.includes('href=\"/admin/billing\"')&&expenseHeader.includes('href=\"/admin/payments/transactions\"')&&expenseHeader.includes('href=\"/admin/provider-mappings\"')",
"expenseHeader.includes('href=\"/admin/billing\"')&&expenseHeader.includes('href=\"/admin/payments/transactions\"')&&expenseHeader.includes('href=\"/admin/payments/export\"')&&expenseHeader.includes('href=\"/admin/provider-mappings\"')")
patch(nav_test,
"assert(rendered.includes('href=\"/admin/payments/transactions\"'),'Transactions must be reachable from the canonical sidebar');\n",
"assert(rendered.includes('href=\"/admin/payments/transactions\"'),'Transactions must be reachable from the canonical sidebar');\nassert(rendered.includes('href=\"/admin/payments/export\"'),'Export data must be reachable from the canonical sidebar');\n")

commerce_test = 'scripts/customer-bot-commerce-smoke.js'
patch(commerce_test,
"['Payments','Provider mappings','Billing','Transactions','Payment Risk Policy','Payment History','Migrate paid users']",
"['Payments','Provider mappings','Billing','Transactions','Export data','Payment Risk Policy','Payment History','Migrate paid users']")
patch(commerce_test,
"['Billing','Transactions','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']",
"['Billing','Transactions','Export data','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk']")

legacy_test = 'scripts/legacy-customer-import-smoke.js'
insert = r'''

// Export must be a real round trip into the existing migration parser.
const portableExport = require('../src/payments/data-export');
const exportedUsers = portableExport.usersCsv([{
  customer_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', export_name:'Portable User', email:'portable@example.com',
  expiration:new Date('2027-08-26T00:00:00Z'), portal_username:'portable', display_name:'Portable User',
  jellyfin_usernames:'portable-jf', created_at:new Date('2026-01-01T00:00:00Z')
}]);
const exportedPayments = portableExport.paymentsCsv([{
  subscription_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email:'portable@example.com', plan_name:'Yearly', plan_code:'yearly', plan_streams:6,
  status:'active', source:'stripe', provider_subscription_id:'sub_real_exported_metadata', provider_customer_id:'cus_real', provider_price_id:'price_real',
  starts_at:new Date('2026-08-26T00:00:00Z'), current_period_end:new Date('2027-08-26T00:00:00Z'), commercial_snapshot:{streams:6},
  amount_minor:6000, currency:'USD', legacy_provider:null, legacy_transaction_id:null, legacy_payment_id:null
}]);
const roundTrip = legacy.normalizedInputs([{name:'Users.csv',text:exportedUsers},{name:'Payments.csv',text:exportedPayments}]);
assert.strictEqual(roundTrip.users.size,1,'exported Users.csv must be accepted by the migration parser');
assert.strictEqual(roundTrip.payments.length,1,'exported Payments.csv must be accepted by the migration parser');
assert.strictEqual(roundTrip.payments[0].email,'portable@example.com');
assert.strictEqual(roundTrip.payments[0].plan.interval,'year');
assert.strictEqual(roundTrip.payments[0].plan.streams,6,'portable export must preserve grandfathered stream allowance');
assert.strictEqual(roundTrip.payments[0].money.minor,6000);
assert.strictEqual(roundTrip.payments[0].provider,'manual','synthetic CAPTAiNFiN migration references must never masquerade as Stripe/PayPal transactions');
assert.strictEqual(roundTrip.payments[0].transactionId,'captainfin-sub-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const zip = portableExport.zipStore([{name:'Users.csv',data:exportedUsers},{name:'Payments.csv',data:exportedPayments}],new Date('2026-08-26T00:00:00Z'));
assert.strictEqual(zip.readUInt32LE(0),0x04034b50,'migration bundle must be a valid ZIP local-header stream');
assert(zip.includes(Buffer.from('Users.csv'))&&zip.includes(Buffer.from('Payments.csv')),'migration bundle must contain the round-trip CSV files');
const exportServiceSource=fs.readFileSync(path.join(root,'src/payments/data-export.js'),'utf8');
const exportAdminSource=fs.readFileSync(path.join(root,'src/platform/admin-data-export.js'),'utf8');
for(const forbidden of ['password_hash','api_key_encrypted','client_secret_encrypted','access_token_encrypted','totp_secret'])assert(!exportServiceSource.includes(forbidden),`portable export query must never select ${forbidden}`);
assert(exportAdminSource.includes("csrf.verify(req)"),'every export download must be CSRF protected');
assert(exportAdminSource.includes("'admin.data_export.download'")||exportServiceSource.includes("'admin.data_export.download'"),'sensitive export downloads must be audit logged');
assert(exportAdminSource.includes('Passwords, sessions, API keys')||exportAdminSource.includes('passwords, password hashes'),'export UI must explicitly disclose excluded secrets');
assert(exportAdminSource.includes('@media(max-width:760px)'),'Export data cards/actions must have a phone layout');
'''
patch(legacy_test,"\nconsole.log('legacy customer import smoke: ok');\n",insert+"\nconsole.log('legacy customer import smoke: ok');\n")

# Ensure the actual browser harness audits the new workflow at phone width and
# executes each download against the real migrated schema.
browser = 'tests/admin-browser-regression.js'
patch(browser,
"'/admin/billing','/admin/payments/transactions']",
"'/admin/billing','/admin/payments/transactions','/admin/payments/export']")
marker = "    inventory.summary={desktopPages:inventory.desktop.length,mobilePages:inventory.mobile.length,uniqueForms:unique(inventory.desktop.flatMap(x=>(x.forms||[]).map(f=>`${f.method} ${f.action}`))).length,uniqueButtons:unique(inventory.desktop.flatMap(x=>x.buttons||[])).length};\n"
download_check = r'''    // Export endpoints are POST + CSRF downloads. Exercise all four against the
    // real clean-install schema so SQL drift cannot hide behind static tests.
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
'''
patch(browser,marker,download_check+marker)

print('data export wiring patch applied')
