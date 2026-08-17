'use strict';

const express=require('express');
const {query}=require('../db');
const {sendCsv}=require('./export');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired')}
function noStore(_q,res,next){res.setHeader('Cache-Control','no-store, private,max-age=0');res.setHeader('Pragma','no-cache');next()}
async function resellerId(userId){const r=await query('SELECT id FROM resellers WHERE user_id=$1',[userId]);if(!r.rowCount)throw new Error('Reseller not found.');return r.rows[0].id}
function createResellerExportRouter(){const r=express.Router();r.get('/reseller/export',gate,noStore,async(req,res,next)=>{try{const id=await resellerId(req.session.authUserId),rows=await query(`SELECT COALESCE(ja.jellyfin_username,c.display_name) AS jellyfin_username,js.name AS server,CASE WHEN EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=c.id AND h.released_at IS NULL) THEN 'suspended' WHEN ja.id IS NULL THEN 'provisioning' ELSE 'active' END AS status,c.created_at FROM customers c LEFT JOIN LATERAL(SELECT * FROM jellyfin_accounts WHERE customer_id=c.id AND account_purpose<>'stremio_internal' ORDER BY is_primary DESC,created_at LIMIT 1)ja ON TRUE LEFT JOIN jellyfin_servers js ON js.id=ja.server_id WHERE c.reseller_id=$1 AND c.reseller_managed=TRUE ORDER BY c.created_at DESC`,[id]);return sendCsv(res,'managed-jellyfin-users.csv',['jellyfin_username','server','status','created_at'],rows.rows)}catch(e){next(e)}});return r}
module.exports={createResellerExportRouter};
