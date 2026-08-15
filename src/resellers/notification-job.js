'use strict';

const { query } = require('../db');
const dispatch = require('../integrations/notification-dispatch');

function utilizationBand(used, limit) {
    if (!limit) return 0;
    const pct = Number(used || 0) / Number(limit) * 100;
    if (pct >= 100) return 100;
    if (pct >= 90) return 90;
    if (pct >= 80) return 80;
    return 0;
}

async function snapshot() {
    const result = await query(`
        SELECT r.id reseller_id,r.estate_suspended_at,
               rs.status subscription_status,rs.grace_until,rs.current_period_end,rs.tier_id,
               COALESCE(rs.tier_name_snapshot,rt.name) tier_name,
               COALESCE(rs.seat_limit_snapshot,rt.seat_limit,0)::int seat_limit,
               COALESCE(seats.used,0)::int seats_used
        FROM resellers r
        LEFT JOIN LATERAL(
          SELECT * FROM reseller_subscriptions WHERE reseller_id=r.id
          ORDER BY CASE WHEN status='active' AND current_period_end>NOW() THEN 0
                        WHEN status='past_due' AND GREATEST(COALESCE(grace_until,'epoch'),COALESCE(manual_grace_until,'epoch'))>NOW() THEN 1
                        ELSE 2 END,
                   current_period_end DESC,created_at DESC LIMIT 1
        ) rs ON TRUE
        LEFT JOIN reseller_tiers rt ON rt.id=rs.tier_id
        LEFT JOIN LATERAL(
          SELECT COUNT(DISTINCT c.id)::int used FROM customers c
          WHERE c.reseller_id=r.id
            AND NOT EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=c.id AND h.released_at IS NULL)
            AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id AND s.superseded_by IS NULL
                AND s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
        ) seats ON TRUE
        ORDER BY r.id
    `);
    return result.rows;
}

async function notify(resellerId, eventType, title, detail, dedupe) {
    try {
        const outcome = await dispatch.resellerEvent(resellerId, eventType, { title, detail, dedupeKey: dedupe });
        if (Array.isArray(outcome?.errors) && outcome.errors.length) return { error: outcome.errors.join('; ') };
        return outcome;
    } catch (error) {
        console.warn(`Reseller notification ${eventType} failed for ${resellerId}:`, error.message);
        return { error: error.message };
    }
}

async function lifecycleTransitions(rows, summary) {
    for (const row of rows) {
        try {
            const grace = Boolean(row.subscription_status === 'past_due' && row.grace_until && new Date(row.grace_until) > new Date());
            const suspended = Boolean(row.estate_suspended_at);
            const band = utilizationBand(row.seats_used, row.seat_limit);
            const old = await query('SELECT * FROM reseller_notification_state WHERE reseller_id=$1', [row.reseller_id]);

            if (!old.rowCount || !old.rows[0].initialized) {
                await query(`
                    INSERT INTO reseller_notification_state(
                        reseller_id,subscription_status,tier_id,grace_active,estate_suspended,utilization_band,initialized,updated_at
                    ) VALUES($1,$2,$3,$4,$5,$6,TRUE,NOW())
                    ON CONFLICT(reseller_id) DO UPDATE SET
                        subscription_status=EXCLUDED.subscription_status,tier_id=EXCLUDED.tier_id,
                        grace_active=EXCLUDED.grace_active,estate_suspended=EXCLUDED.estate_suspended,
                        utilization_band=EXCLUDED.utilization_band,initialized=TRUE,updated_at=NOW()
                `, [row.reseller_id,row.subscription_status||null,row.tier_id||null,grace,suspended,band]);
                summary.processed += 1;
                continue;
            }

            const prior = old.rows[0];
            const messages = [];
            if (prior.subscription_status !== row.subscription_status) {
                if (row.subscription_status === 'active') {
                    messages.push(['reseller.subscription.activated','Reseller subscription active',
                        `Your monthly reseller subscription is active through ${row.current_period_end ? new Date(row.current_period_end).toLocaleDateString('en-GB') : 'the current paid period'}.`]);
                } else if (row.subscription_status === 'past_due') {
                    messages.push(['reseller.payment.failed','Reseller payment needs attention',
                        'The recurring reseller subscription is past due. Restore billing before access is suspended.']);
                } else if (['cancelled','expired'].includes(row.subscription_status)) {
                    messages.push(['reseller.subscription.cancelled','Reseller subscription ended',
                        `The reseller subscription is ${row.subscription_status}. Paid-through access and estate policy follow the recorded entitlement dates.`]);
                }
            }
            if (prior.tier_id && row.tier_id && String(prior.tier_id) !== String(row.tier_id)) {
                messages.push(['reseller.tier.changed','Reseller tier changed',
                    `Your monthly reseller tier is now ${row.tier_name || 'the updated tier'} with ${row.seat_limit} active customer entitlements.`]);
            }
            if (!prior.grace_active && grace) {
                const graceEnds = new Date(row.grace_until).toLocaleString('en-GB');
                messages.push(['reseller.grace.started','Reseller payment grace started',
                    `A payment grace period is active until ${graceEnds}.`]);
                messages.push(['reseller.suspension.scheduled','Estate suspension scheduled',
                    `If billing is not restored by ${graceEnds}, your reseller Jellyfin account and the Jellyfin accounts you manage will be suspended automatically. Accounts are preserved and can be restored after payment returns.`]);
            }
            if (!prior.estate_suspended && suspended) {
                messages.push(['reseller.estate.suspended','Reseller estate suspended',
                    'The reseller parent entitlement is not active and customer-estate access has been suspended.']);
            }
            if (prior.estate_suspended && !suspended) {
                messages.push(['reseller.estate.restored','Reseller estate restored',
                    'The reseller parent entitlement is active and the billing estate hold has been removed.']);
            }
            if (band > Number(prior.utilization_band || 0) && band >= 80) {
                messages.push(['reseller.seat_usage',`Reseller capacity ${band}%`,
                    `${row.seats_used} of ${row.seat_limit} active customer entitlements are in use. Consider upgrading before additional activation is needed.`]);
            }

            for (const [event,title,detail] of messages) {
                const outcome = await notify(row.reseller_id,event,title,detail,
                    `${event}:${row.reseller_id}:${row.tier_id||'none'}:${row.subscription_status||'none'}:${band}:${row.current_period_end||''}`);
                if (outcome?.error) summary.failed += 1; else summary.notifications += 1;
            }

            await query(`
                UPDATE reseller_notification_state
                SET subscription_status=$2,tier_id=$3,grace_active=$4,estate_suspended=$5,utilization_band=$6,updated_at=NOW()
                WHERE reseller_id=$1
            `, [row.reseller_id,row.subscription_status||null,row.tier_id||null,grace,suspended,band]);
            summary.processed += 1;
        } catch (error) {
            summary.failed += 1;
            console.warn(`Reseller notification observer failed for ${row.reseller_id}:`, error.message);
        }
    }
}

function expiryThreshold(periodEnd) {
    const remaining = (new Date(periodEnd).getTime() - Date.now()) / 86400000;
    if (remaining <= 0 || remaining > 7) return 0;
    if (remaining <= 1) return 1;
    if (remaining <= 3) return 3;
    return 7;
}

async function downstreamExpiryWarnings(summary) {
    const expiring = await query(`
        SELECT c.reseller_id,c.id customer_id,c.display_name,s.id subscription_id,s.current_period_end,p.name plan_name
        FROM customers c
        JOIN subscriptions s ON s.customer_id=c.id AND s.superseded_by IS NULL
        JOIN plans p ON p.id=s.plan_id
        WHERE c.reseller_id IS NOT NULL AND c.is_reseller_owner=FALSE
          AND s.status IN('active','trialing','past_due','paused')
          AND s.current_period_end>NOW() AND s.current_period_end<=NOW()+INTERVAL '7 days'
        ORDER BY s.current_period_end,c.id
    `);

    for (const row of expiring.rows) {
        const days = expiryThreshold(row.current_period_end);
        if (!days) continue;
        try {
            const claim = await query(`
                INSERT INTO reseller_customer_expiry_notices(reseller_id,customer_id,subscription_id,days_before)
                VALUES($1,$2,$3,$4)
                ON CONFLICT(subscription_id,days_before) DO NOTHING
                RETURNING id
            `, [row.reseller_id,row.customer_id,row.subscription_id,days]);
            if (!claim.rowCount) continue;

            const end = new Date(row.current_period_end).toLocaleString('en-GB');
            const outcome = await notify(row.reseller_id,'reseller.customer.expiring',
                `${row.display_name || 'Customer'} access expires soon`,
                `${row.display_name || 'Customer'} (${row.plan_name || 'plan'}) expires ${end}. Renew or intentionally allow the entitlement to end.`,
                `reseller.customer.expiring:${row.subscription_id}:${days}`);
            if (outcome?.error) {
                summary.failed += 1;
                await query('DELETE FROM reseller_customer_expiry_notices WHERE id=$1', [claim.rows[0].id]).catch(()=>{});
            } else {
                summary.notifications += 1;
                summary.customerExpiryWarnings += 1;
            }
        } catch (error) {
            summary.failed += 1;
            console.warn(`Reseller customer expiry notification failed for ${row.subscription_id}:`, error.message);
        }
    }
}

async function process() {
    const rows = await snapshot();
    const summary = { total: rows.length, processed: 0, notifications: 0, customerExpiryWarnings: 0, failed: 0 };
    await lifecycleTransitions(rows, summary);
    await downstreamExpiryWarnings(summary);
    return summary;
}

module.exports = { process, snapshot, utilizationBand, expiryThreshold, downstreamExpiryWarnings };
