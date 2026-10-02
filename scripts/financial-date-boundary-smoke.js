'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const calendarDate=require('../src/finance/calendar-date');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

for(const value of ['2001-01-01','2001-07-15','2004-02-29','2099-12-31']){
  assert.strictEqual(calendarDate.text(value),value,`${value} must remain an exact calendar label`);
  assert.strictEqual(calendarDate.startUtc(value).toISOString(),`${value}T00:00:00.000Z`);
}
for(const invalid of ['',null,undefined,'2001-02-29','2001-13-01','not-a-date']){
  assert.strictEqual(calendarDate.text(invalid),null,`${invalid} must not become an implicit financial date`);
}
assert.strictEqual(calendarDate.addDaysUtc('2001-03-31',1).toISOString(),'2001-04-01T00:00:00.000Z');
assert.strictEqual(calendarDate.addDaysUtc('2001-10-28',1).toISOString(),'2001-10-29T00:00:00.000Z');

const expenses=read('src/platform/business-expenses.js');
assert(expenses.includes("require('../finance/calendar-date')"),'business expenses must use the canonical calendar-date boundary');
assert(expenses.includes('start_date::text AS start_date')&&expenses.includes('end_date::text AS end_date'),
  'PostgreSQL expense DATE columns must cross into Node as YYYY-MM-DD text');

const expenseUi=read('src/platform/admin-expenses.js');
assert(expenseUi.includes("require('../finance/calendar-date')")&&expenseUi.includes('calendarDate.startUtc(value)'),
  'expense rendering must use the same explicit UTC calendar-date conversion');

const ledger=read('src/payments/dashboard-ledger.js');
const orders=read('src/platform/admin-orders.js');
assert(ledger.includes("require('../finance/calendar-date')"),'payment coverage must use the canonical calendar-date boundary');
assert(ledger.includes('range_start::text AS range_start')&&ledger.includes('range_end::text AS range_end'),
  'payment-history coverage DATE columns must cross into Node as YYYY-MM-DD text');
assert(ledger.includes('calendarDate.startUtc(value)'),'coverage interval arithmetic must begin from explicit UTC calendar dates');
assert(orders.includes("require('../finance/calendar-date')")&&orders.includes('calendarDate.startUtc(value)'),
  'commerce order date filters must reuse the canonical calendar-date parser');

const migrations=read('db/migrations/20261001163000_refund_queue_elapsed_time.sql');
assert(/EXTRACT\(EPOCH FROM \(?refunded\.current_period_end-refunded\.starts_at\)?\)/.test(migrations),
  'prepaid duration movement must use elapsed time rather than calendar-day arithmetic');

const dangerous=[];
for(const folder of ['src']){
  const walk=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name);
      if(entry.isDirectory())walk(full);
      else if(entry.isFile()&&entry.name.endsWith('.js')){
        const rel=path.relative(root,full).replace(/\\/g,'/');
        const source=fs.readFileSync(full,'utf8');
        if(/new Date\(\s*(?:row\.)?(?:start_date|end_date|range_start|range_end)\s*\)/.test(source))dangerous.push(rel);
      }
    }
  };
  walk(path.join(root,folder));
}
assert.deepStrictEqual(dangerous,[],'financial DATE fields must not be implicitly converted through the Node process timezone');

console.log('financial calendar-date boundary smoke: ok');
