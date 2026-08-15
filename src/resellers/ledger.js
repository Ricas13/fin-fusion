'use strict';

const { query, transaction } = require('../db');
const settings = require('./settings');

function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }
function minorFromMoney(value, { allowNegative = false } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('Enter a valid amount.');
    const minor = Math.round(n * 100);
    if (!allowNegative && minor < 0) throw new Error('Amount cannot be negative.');
    if (Math.abs(minor) > 1000000000) throw new Error('Amount is too large.');
    return minor;
}

async function ownedSale(client, resellerId, saleId) {
    const result = await client.query(`
        SELECT rs.*,c.display_name,p.name AS plan_name
        FROM reseller_sales rs
        LEFT JOIN customers c ON c.id=rs.customer_id
        LEFT JOIN plans p ON p.id=rs.plan_id
        WHERE rs.id=$1 AND rs.reseller_id=$2
        FOR UPDATE OF rs
    `, [saleId, resellerId]);
    if (!result.rowCount) throw new Error('Sale ledger entry not found.');
    return result.rows[0];
}

async function refundableRemaining(client, resellerId, sale) {
    if (!['sale','adjustment'].includes(sale.sale_type) || Number(sale.amount_minor) <= 0 || sale.voided_at) return 0;
    const result = await client.query(`
        SELECT COALESCE(SUM(amount_minor),0)::bigint refunded
        FROM reseller_sales
        WHERE reseller_id=$1 AND parent_sale_id=$2 AND sale_type='refund' AND voided_at IS NULL
    `, [resellerId, sale.id]);
    return Math.max(0, Number(sale.amount_minor) - Number(result.rows[0]?.refunded || 0));
}

async function refund({ resellerId, saleId, amount, note = '', externalReference = '', actorUserId = null }) {
    return transaction(async client => {
        const sale = await ownedSale(client, resellerId, saleId);
        const requested = minorFromMoney(amount);
        if (requested <= 0) throw new Error('Refund amount must be greater than zero.');
        const remaining = await refundableRemaining(client, resellerId, sale);
        if (requested > remaining) throw new Error(`Only ${(remaining / 100).toFixed(2)} remains refundable on this sale.`);
        const row = await client.query(`
            INSERT INTO reseller_sales(
                reseller_id,customer_id,plan_id,amount_minor,currency,payment_method,
                service_starts_at,service_ends_at,note,sale_type,parent_sale_id,actor_user_id,external_reference,metadata
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'refund',$10,$11,$12,$13::jsonb)
            RETURNING *
        `, [resellerId,sale.customer_id,sale.plan_id,requested,sale.currency,sale.payment_method,
            sale.service_starts_at,sale.service_ends_at,clean(note,500),sale.id,actorUserId,clean(externalReference,200),
            JSON.stringify({ originalAmountMinor: Number(sale.amount_minor), policy: 'accounting_only' })]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'reseller.sale.refund','reseller_sale',$2,$3::jsonb)`, [actorUserId,row.rows[0].id,JSON.stringify({resellerId,parentSaleId:sale.id,amountMinor:requested,currency:String(sale.currency).trim()})]);
        return row.rows[0];
    });
}

async function voidEntry({ resellerId, saleId, reason = '', actorUserId = null }) {
    return transaction(async client => {
        const sale = await ownedSale(client, resellerId, saleId);
        if (sale.voided_at) throw new Error('This ledger entry is already voided.');
        const children = await client.query(`SELECT COUNT(*)::int n FROM reseller_sales WHERE reseller_id=$1 AND parent_sale_id=$2 AND voided_at IS NULL`, [resellerId,sale.id]);
        if (Number(children.rows[0]?.n || 0) > 0) throw new Error('Void child refund/adjustment entries first so the audit trail remains coherent.');
        const result = await client.query(`UPDATE reseller_sales SET voided_at=NOW(),metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb
            WHERE id=$1 AND reseller_id=$2 RETURNING *`, [sale.id,resellerId,JSON.stringify({ voidReason: clean(reason,500), voidedBy: actorUserId })]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'reseller.sale.void','reseller_sale',$2,$3::jsonb)`, [actorUserId,sale.id,JSON.stringify({resellerId,reason:clean(reason,500)})]);
        return result.rows[0];
    });
}

async function adjustment({ resellerId, customerId = null, parentSaleId = null, amount, note = '', externalReference = '', actorUserId = null }) {
    const cfg = await settings.forReseller(resellerId);
    const amountMinor = minorFromMoney(amount, { allowNegative: true });
    if (!amountMinor) throw new Error('Adjustment cannot be zero.');
    return transaction(async client => {
        let parent = null;
        if (parentSaleId) parent = await ownedSale(client, resellerId, parentSaleId);
        let customer = customerId || parent?.customer_id || null;
        if (!customer) {
            const fallback = await client.query(`SELECT id FROM customers WHERE reseller_id=$1 ORDER BY is_reseller_owner ASC,created_at LIMIT 1`, [resellerId]);
            customer = fallback.rows[0]?.id || null;
        }
        if (!customer) throw new Error('Create a reseller customer before recording an adjustment.');
        const ownership = await client.query('SELECT id FROM customers WHERE id=$1 AND reseller_id=$2', [customer,resellerId]);
        if (!ownership.rowCount) throw new Error('Customer does not belong to this reseller.');
        const row = await client.query(`
            INSERT INTO reseller_sales(
                reseller_id,customer_id,plan_id,amount_minor,currency,payment_method,
                service_starts_at,service_ends_at,note,sale_type,parent_sale_id,actor_user_id,external_reference,metadata
            ) VALUES($1,$2,$3,$4,$5,'adjustment',NOW(),NULL,$6,'adjustment',$7,$8,$9,$10::jsonb)
            RETURNING *
        `, [resellerId,customer,parent?.plan_id||null,amountMinor,cfg.ledgerCurrency,clean(note,500),parent?.id||null,actorUserId,clean(externalReference,200),JSON.stringify({ policy:'accounting_only' })]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'reseller.sale.adjustment','reseller_sale',$2,$3::jsonb)`, [actorUserId,row.rows[0].id,JSON.stringify({resellerId,parentSaleId:parent?.id||null,amountMinor,currency:cfg.ledgerCurrency})]);
        return row.rows[0];
    });
}

async function list(resellerId, { limit = 1000 } = {}) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
    const result = await query(`
        SELECT rs.*,p.name plan_name,c.display_name,
               COALESCE((SELECT SUM(ch.amount_minor) FROM reseller_sales ch WHERE ch.parent_sale_id=rs.id AND ch.sale_type='refund' AND ch.voided_at IS NULL),0)::bigint refunded_minor
        FROM reseller_sales rs
        LEFT JOIN plans p ON p.id=rs.plan_id
        LEFT JOIN customers c ON c.id=rs.customer_id
        WHERE rs.reseller_id=$1
        ORDER BY rs.created_at DESC LIMIT $2
    `, [resellerId,safeLimit]);
    return result.rows;
}

module.exports={refund,voidEntry,adjustment,list,refundableRemaining};
