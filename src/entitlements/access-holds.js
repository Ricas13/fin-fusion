'use strict';

const { query, transaction } = require('../db');

function runner(client) { return client || { query }; }
function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }

async function syncLegacySummary(customerId, client = null) {
    const db = runner(client);
    const active = await db.query(`
        SELECT hold_type,source_key,reason,created_at
        FROM customer_access_holds
        WHERE customer_id=$1 AND released_at IS NULL
        ORDER BY created_at,id
    `, [customerId]);
    if (!active.rowCount) {
        await db.query('UPDATE customers SET access_paused_at=NULL,access_hold_reason=NULL WHERE id=$1', [customerId]);
        return [];
    }
    const first = active.rows[0];
    const reason = active.rowCount === 1
        ? (first.reason || `${first.hold_type}:${first.source_key}`)
        : `multiple_access_holds:${active.rows.map(row => row.hold_type).join(',')}`;
    await db.query(`
        UPDATE customers SET access_paused_at=$2,access_hold_reason=$3 WHERE id=$1
    `, [customerId, first.created_at || new Date(), reason.slice(0, 500)]);
    return active.rows;
}

async function addHold({ customerId, type, sourceKey = '', reason = '', actorUserId = null, metadata = {} }, client = null) {
    const execute = async db => {
        const holdType = clean(type, 80);
        if (!holdType) throw new Error('Access hold type is required.');
        const key = clean(sourceKey, 200);
        const result = await db.query(`
            INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,metadata,actor_user_id)
            VALUES($1,$2,$3,$4,$5::jsonb,$6)
            ON CONFLICT (customer_id,hold_type,source_key) WHERE released_at IS NULL
            DO UPDATE SET reason=EXCLUDED.reason,metadata=EXCLUDED.metadata,actor_user_id=EXCLUDED.actor_user_id
            RETURNING *
        `, [customerId, holdType, key, clean(reason, 500), JSON.stringify(metadata || {}), actorUserId]);
        await syncLegacySummary(customerId, db);
        await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'customer.access_hold.add','customer',$2,$3::jsonb)`,
        [actorUserId, customerId, JSON.stringify({ type: holdType, sourceKey: key, reason: clean(reason, 500) })]);
        return result.rows[0];
    };
    if (client) return execute(client);
    return transaction(execute);
}

async function releaseHold({ customerId, type, sourceKey = null, actorUserId = null, resolutionReason = '' }, client = null) {
    const execute = async db => {
        const holdType = clean(type, 80);
        const releaseReason = clean(resolutionReason, 500);
        const params = [customerId, holdType, actorUserId];
        let sql = `UPDATE customer_access_holds SET released_at=NOW(),released_by=$3
                   WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL`;
        if (sourceKey !== null) { params.push(clean(sourceKey, 200)); sql += ' AND source_key=$4'; }
        const released = await db.query(`${sql} RETURNING id,source_key`, params);
        await syncLegacySummary(customerId, db);
        if (released.rowCount) {
            await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'customer.access_hold.release','customer',$2,$3::jsonb)`,
            [actorUserId, customerId, JSON.stringify({ type: holdType, sourceKey, released: released.rowCount, resolutionReason: releaseReason || null })]);
        }
        return released.rowCount;
    };
    if (client) return execute(client);
    return transaction(execute);
}

async function releaseAllAdminHolds(customerId, actorUserId = null) {
    return transaction(async client => {
        const result = await client.query(`
            UPDATE customer_access_holds SET released_at=NOW(),released_by=$2
            WHERE customer_id=$1 AND released_at IS NULL
              AND hold_type IN ('admin_disabled','admin_suspended','legacy')
            RETURNING id
        `, [customerId, actorUserId]);
        await syncLegacySummary(customerId, client);
        return result.rowCount;
    });
}

async function activeHolds(customerId, client = null) {
    const db = runner(client);
    const result = await db.query(`SELECT * FROM customer_access_holds
        WHERE customer_id=$1 AND released_at IS NULL ORDER BY created_at,id`, [customerId]);
    return result.rows;
}

async function isBlocked(customerId, client = null) {
    const db = runner(client);
    const result = await db.query(`SELECT EXISTS(
        SELECT 1 FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL
    ) AS blocked`, [customerId]);
    return Boolean(result.rows[0]?.blocked);
}

module.exports = { addHold, releaseHold, releaseAllAdminHolds, activeHolds, isBlocked, syncLegacySummary };
