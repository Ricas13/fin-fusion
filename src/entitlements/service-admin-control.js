'use strict';

const { query, transaction } = require('../db');

const SERVICES = new Set(['jellyfin', 'stremio', 'overseerr']);
const MODES = new Set(['admin_present', 'admin_removed', 'admin_server_pin']);

function assertService(service) {
    const value = String(service || '');
    if (!SERVICES.has(value)) throw new Error(`Unsupported service "${value}" for admin authority.`);
    return value;
}
function note(value, fallback) { return String(value || fallback || 'Administrator override').trim().slice(0, 500) || String(fallback || 'Administrator override'); }

// Canonical, service-scoped (NOT subscription-scoped) administrator
// authority. This is the generalized replacement for the old Jellyfin-only
// customer_jellyfin_admin_control: authority here survives subscription
// churn (a plan change, a renewal, a new checkout after a payment failure)
// because it is keyed to (customer_id, service), not to a specific
// subscription row. Absence of a row means "automatic" - normal commercial/
// free-tier rules decide the service's state.
async function state(customerId, service, { client = null } = {}) {
    assertService(service);
    if (!customerId) return null;
    const db = client || { query };
    const result = await db.query(`
        SELECT c.*, js.name AS server_name, js.server_class AS server_class,
               js.enabled AS server_enabled, js.health_status AS server_health
        FROM customer_service_admin_control c
        LEFT JOIN jellyfin_servers js ON js.id = c.server_id
        WHERE c.customer_id = $1 AND c.service = $2
        LIMIT 1
    `, [customerId, service]);
    return result.rows[0] || null;
}

async function upsert(customerId, service, mode, { serverId = null, actorUserId = null, reason = '', auditAction }) {
    assertService(service);
    if (!MODES.has(mode)) throw new Error(`Unsupported admin authority mode "${mode}".`);
    const why = note(reason, 'Administrator override');
    return transaction(async client => {
        const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
        if (!customer.rowCount) throw new Error('Customer not found.');
        let server = null;
        if (mode === 'admin_server_pin') {
            if (service !== 'jellyfin') throw new Error('Server pinning is only meaningful for Jellyfin.');
            const found = await client.query(`SELECT id,name,server_class,media_server_type,enabled,health_status FROM jellyfin_servers WHERE id=$1 FOR UPDATE`, [serverId]);
            if (!found.rowCount || String(found.rows[0].media_server_type || 'jellyfin') !== 'jellyfin') throw new Error('Choose a configured Jellyfin server.');
            server = found.rows[0];
        }
        await client.query(`
            INSERT INTO customer_service_admin_control(customer_id,service,mode,server_id,reason,created_by,updated_by,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$6,NOW())
            ON CONFLICT(customer_id,service) DO UPDATE SET
                mode=EXCLUDED.mode, server_id=EXCLUDED.server_id, reason=EXCLUDED.reason,
                updated_by=EXCLUDED.updated_by, updated_at=NOW()
        `, [customerId, service, mode, server?.id || null, why, actorUserId]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,
            [actorUserId, auditAction, customerId, JSON.stringify({ service, mode, serverId: server?.id || null, serverName: server?.name || null, reason: why })]);
        return { service, mode, serverId: server?.id || null };
    });
}

async function setPresent(customerId, service, { actorUserId = null, reason = '' } = {}) {
    return upsert(customerId, service, 'admin_present', { actorUserId, reason, auditAction: 'admin.customer.service_admin_control.set_present' });
}

async function setRemoved(customerId, service, { actorUserId = null, reason = '' } = {}) {
    return upsert(customerId, service, 'admin_removed', { actorUserId, reason, auditAction: 'admin.customer.service_admin_control.set_removed' });
}

async function pinServer(customerId, serverId, { actorUserId = null, reason = '' } = {}) {
    return upsert(customerId, 'jellyfin', 'admin_server_pin', { serverId, actorUserId, reason, auditAction: 'admin.customer.service_admin_control.pin_server' });
}

async function clear(customerId, service, { actorUserId = null, reason = '' } = {}) {
    assertService(service);
    const why = note(reason, 'Returned to automatic management');
    return transaction(async client => {
        const previous = await client.query('SELECT * FROM customer_service_admin_control WHERE customer_id=$1 AND service=$2 FOR UPDATE', [customerId, service]);
        if (!previous.rowCount) return { changed: false };
        await client.query('DELETE FROM customer_service_admin_control WHERE customer_id=$1 AND service=$2', [customerId, service]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.service_admin_control.return_to_automatic','customer',$2,$3::jsonb)`,
            [actorUserId, customerId, JSON.stringify({ service, previousMode: previous.rows[0].mode, previousServerId: previous.rows[0].server_id || null, reason: why })]);
        return { changed: true, previous: previous.rows[0] };
    });
}

module.exports = { SERVICES, MODES, state, setPresent, setRemoved, pinServer, clear };
