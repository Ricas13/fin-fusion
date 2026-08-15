'use strict';

const express=require('express');
const {query}=require('../db');
const {sendCsv}=require('./export');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired')}
function noStore(_q,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
async function resellerId(userId){const r=await query('SELECT id FROM resellers WHERE user_id=$1',[userId]);if(!r.rowCount)throw new Error('Reseller not found.');return r.rows[0].id}
function createResellerExportRouter(){const r=express.Router();r.get('/reseller/export',gate,noStore,async(req,res,next)=>{try{const id=await resellerId(req.session.authUserId),rows=await query(`SELECT c.display_name AS customer,ja.jellyfin_username,js.name AS server,p.name AS plan,s.status,s.current_period_end,c.created_at FROM customers c LEFT JOIN LATERAL(SELECT * FROM subscriptions sx WHERE sx.customer_id=c.id AND sx.superseded_by IS NULL ORDER BY sx.current_period_end DESC,sx.created_at DESC LIMIT 1)s ON TRUE LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN jellyfin_accounts ja ON ja.customer_id=c.id AND ja.is_primary=TRUE LEFT JOIN jellyfin_servers js ON js.id=ja.server_id WHERE c.reseller_id=$1 ORDER BY c.created_at DESC`,[id]);return sendCsv(res,'reseller-customers.csv',['customer','jellyfin_username','server','plan','status','current_period_end','created_at'],rows.rows)}catch(e){next(e)}});return r}
module.exports={createResellerExportRouter};
