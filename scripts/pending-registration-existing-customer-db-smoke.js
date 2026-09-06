'use strict';

const assert=require('assert');
const crypto=require('crypto');
const {query}=require('../src/db');
const pending=require('../src/security/pending-registration');

async function main(){
  const tag=`portal-link-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const password='PortalLink!2026Aa';
  const customerIds=[];
  const userIds=[];
  const pendingIds=[];
  try{
    const existingEmail=`${tag}-existing@example.test`;
    const existing=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`${tag} imported`,existingEmail.toUpperCase()])).rows[0];
    customerIds.push(existing.id);
    const first=await pending.begin({email:existingEmail,username:`${tag}-existing`.slice(0,40),password});
    pendingIds.push(first.id);
    const linked=await pending.consume(first.token);
    assert(linked?.user?.id,'verified existing-customer registration did not create a portal user');
    userIds.push(linked.user.id);
    assert.equal(String(linked.customer.id),String(existing.id),'verified registration created a duplicate customer instead of linking the imported customer');
    const linkedRows=await query(`SELECT id,user_id,email FROM customers WHERE lower(BTRIM(email))=lower(BTRIM($1)) ORDER BY created_at`,[existingEmail]);
    assert.equal(linkedRows.rowCount,1,'verified registration left more than one customer row for the imported email');
    assert.equal(String(linkedRows.rows[0].user_id),String(linked.user.id),'existing customer was not linked to the verified portal user');

    const newEmail=`${tag}-new@example.test`;
    const second=await pending.begin({email:newEmail,username:`${tag}-new`.slice(0,40),password});
    pendingIds.push(second.id);
    const created=await pending.consume(second.token);
    assert(created?.customer?.id,'brand-new verified registration did not create a customer');
    customerIds.push(created.customer.id);userIds.push(created.user.id);
    const newRows=await query(`SELECT id,user_id FROM customers WHERE lower(BTRIM(email))=lower(BTRIM($1))`,[newEmail]);
    assert.equal(newRows.rowCount,1,'brand-new registration did not create exactly one customer');
    assert.equal(String(newRows.rows[0].id),String(created.customer.id),'brand-new registration returned the wrong customer');

    const ambiguousEmail=`${tag}-ambiguous@example.test`;
    for(let i=1;i<=2;i+=1){const row=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`${tag} ambiguous ${i}`,ambiguousEmail])).rows[0];customerIds.push(row.id);}
    const third=await pending.begin({email:ambiguousEmail,username:`${tag}-ambiguous`.slice(0,40),password});
    pendingIds.push(third.id);
    let ambiguousRejected=false;
    try{await pending.consume(third.token);}catch(error){ambiguousRejected=/multiple customer records/i.test(String(error?.message||''));}
    assert(ambiguousRejected,'multiple same-email customer rows were not rejected safely');
    const ambiguousUsers=await query(`SELECT id FROM app_users WHERE lower(COALESCE(email,''))=lower($1)`,[ambiguousEmail]);
    assert.equal(ambiguousUsers.rowCount,0,'ambiguous registration created a portal user before rejecting the unsafe link');
    const ambiguousCustomers=await query(`SELECT user_id FROM customers WHERE lower(BTRIM(email))=lower(BTRIM($1))`,[ambiguousEmail]);
    assert.equal(ambiguousCustomers.rowCount,2,'ambiguous registration changed the customer row set');
    assert(ambiguousCustomers.rows.every(row=>row.user_id==null),'ambiguous registration linked one of the candidate customers');
    const terminal=(await query(`SELECT consumed_at FROM pending_registrations WHERE id=$1`,[third.id])).rows[0];
    assert(terminal?.consumed_at,'ambiguous registration token remained reusable after safe rejection');

    console.log('pending registration existing-customer DB smoke: ok');
  } finally {
    for(const id of pendingIds)await query(`DELETE FROM pending_registrations WHERE id=$1`,[id]).catch(()=>{});
    for(const id of customerIds)await query(`DELETE FROM customers WHERE id=$1`,[id]).catch(()=>{});
    for(const id of userIds)await query(`DELETE FROM app_users WHERE id=$1`,[id]).catch(()=>{});
    await query(`DELETE FROM pending_registrations WHERE email LIKE $1`,[`%${tag}%`]).catch(()=>{});
    await query(`DELETE FROM customers WHERE email ILIKE $1`,[`%${tag}%`]).catch(()=>{});
    await query(`DELETE FROM app_users WHERE email ILIKE $1`,[`%${tag}%`]).catch(()=>{});
  }
}

main().then(()=>process.exit(0)).catch(error=>{console.error(error.stack||error);process.exit(1);});
