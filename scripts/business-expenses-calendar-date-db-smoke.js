'use strict';

const assert=require('assert');
const expenses=require('../src/platform/business-expenses');
const {runDbSmoke,withTimezones}=require('./db-test-fixture');

runDbSmoke('business expense calendar date DB smoke',async()=>{
  const createdIds=[];
  try{
    await withTimezones(['UTC','Europe/London','America/New_York','Asia/Kolkata'],async zone=>{
      const created=await expenses.create({
        name:`Calendar date ${zone}`,
        supplier:'Test',
        category:'Test',
        amountMinor:100,
        currency:'GBP',
        recurrence:'one_time',
        startDate:'2001-07-15',
        endDate:'2001-07-16',
        active:true,
        reference:null,
        notes:null
      },null);
      createdIds.push(created.id);
      assert.strictEqual(created.start_date,'2001-07-15',`${zone}: create must return start DATE as calendar text`);
      assert.strictEqual(created.end_date,'2001-07-16',`${zone}: create must return end DATE as calendar text`);

      const listed=(await expenses.list()).find(row=>String(row.id)===String(created.id));
      assert(listed,`${zone}: created expense must be readable`);
      assert.strictEqual(listed.start_date,'2001-07-15',`${zone}: list must preserve start calendar date`);
      assert.strictEqual(listed.end_date,'2001-07-16',`${zone}: list must preserve end calendar date`);

      const updated=await expenses.update(created.id,{
        name:`Calendar date updated ${zone}`,
        supplier:'Test',
        category:'Test',
        amountMinor:100,
        currency:'GBP',
        recurrence:'one_time',
        startDate:'2001-12-31',
        endDate:null,
        active:true,
        reference:null,
        notes:null
      });
      assert.strictEqual(updated.start_date,'2001-12-31',`${zone}: update must return DATE as calendar text`);
      assert.strictEqual(updated.end_date,null,`${zone}: nullable DATE must remain null`);
    });
  }finally{
    for(const id of createdIds){
      try{await expenses.remove(id);}catch(_){}
    }
  }
});
