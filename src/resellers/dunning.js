'use strict';

const { query, transaction } = require('../db');
const monthly = require('./monthly');

function daysValue(value) {
    const days = Number.parseInt(value, 10);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('Grace extension must be between 1 and 30 days.');
    return days;
}

async function status(resellerId) {
    const row = await monthly.currentSubscription(resellerId);
    if (!row) return { subscription: null, effectiveGraceUntil: null, suspensionAt: null };
    const dates = [row.grace_until, row.manual_grace_until].filter(Boolean).map(v => new Date(v)).filter(v => Number.isFinite(v.getTime()));
    const effectiveGraceUntil = dates.length ? new Date(Math.max(...dates.map(v => v.getTime()))) : null;
    const periodEnd = row.current_period_end ? new Date(row.current_period_end) : null;
    const suspensionAt = effectiveGraceUntil || periodEnd;
    return { subscription: row, effectiveGraceUntil, suspensionAt };
}

async function extendGrace({ resellerId, days, reason, actorUserId = null }) {
    const safeDays = daysValue(days);
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (!cleanReason) throw new Error('Enter a reason for the manual grace extension.');
    const result = await transaction(async client => {
        const current = await client.query(`
            SELECT rs.*,COALESCE(rs.tier_name_snapshot,rt.name) tier_name
            FROM reseller_subscriptions rs JOIN reseller_tiers rt ON rt.id=rs.tier_id
            WHERE rs.reseller_id=$1
            ORDER BY CASE WHEN rs.status='past_due' THEN 0 WHEN rs.status='active' THEN 1 ELSE 2 END,
                     rs.current_period_end DESC,rs.created_at DESC
            LIMIT 1 FOR UPDATE OF rs
        `, [resellerId]);
        if (!current.rowCount) throw new Error('This reseller has no monthly subscription to extend.');
        const row = current.rows[0];
        if (row.status !== 'past_due') {
            if (row.status === 'active') throw new Error('The reseller is currently paid and active; grace is only needed after a failed renewal.');
            throw new Error(`Manual payment-failure grace is not available while the subscription is ${row.status}.`);
        }
        const baseCandidates = [Date.now()];
        for (const value of [row.grace_until,row.manual_grace_until]) {
            const parsed = value ? new Date(value).getTime() : NaN;
            if (Number.isFinite(parsed)) baseCandidates.push(parsed);
        }
        const until = new Date(Math.max(...baseCandidates) + safeDays * 86400000);
        const saved = await client.query(`
            UPDATE reseller_subscriptions
            SET grace_until=GREATEST(COALESCE(grace_until,$2),$2),
                manual_grace_until=$2,manual_grace_reason=$3,manual_grace_updated_by=$4,
                manual_grace_updated_at=NOW(),updated_at=NOW()
            WHERE id=$1 RETURNING *
        `, [row.id,until,cleanReason,actorUserId]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.reseller.grace.extend','reseller',$2,$3::jsonb)
        `, [actorUserId,resellerId,JSON.stringify({subscriptionId:row.id,days:safeDays,until:until.toISOString(),reason:cleanReason})]);
        return saved.rows[0];
    });
    await monthly.reconcileEstate(resellerId);
    return result;
}

async function clearManualGrace({ resellerId, reason, actorUserId = null }) {
    const cleanReason = String(reason || '').trim().slice(0,500);
    if (!cleanReason) throw new Error('Enter a reason for removing manual grace.');
    const result = await transaction(async client => {
        const current = await client.query(`SELECT * FROM reseller_subscriptions WHERE reseller_id=$1 ORDER BY current_period_end DESC,created_at DESC LIMIT 1 FOR UPDATE`, [resellerId]);
        if (!current.rowCount) throw new Error('Reseller subscription not found.');
        const row = current.rows[0];
        if (!row.manual_grace_until) throw new Error('No manual grace override is active.');
        const tier = await client.query('SELECT COALESCE($2::int,grace_days,0)::int grace_days FROM reseller_tiers WHERE id=$1', [row.tier_id,row.grace_days_snapshot]);
        const naturalDays = Number(tier.rows[0]?.grace_days || 0);
        const naturalUntil = row.status === 'past_due' && naturalDays > 0
            ? new Date(Date.now() + naturalDays * 86400000)
            : null;
        await client.query(`UPDATE reseller_subscriptions SET manual_grace_until=NULL,manual_grace_reason=NULL,manual_grace_updated_by=NULL,manual_grace_updated_at=NULL,grace_until=$2,updated_at=NOW() WHERE id=$1`, [row.id,naturalUntil]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.reseller.grace.clear','reseller',$2,$3::jsonb)`, [actorUserId,resellerId,JSON.stringify({subscriptionId:row.id,reason:cleanReason,naturalGraceUntil:naturalUntil?.toISOString()||null})]);
        return row;
    });
    await monthly.reconcileEstate(resellerId);
    return result;
}

module.exports = { status, extendGrace, clearManualGrace };
