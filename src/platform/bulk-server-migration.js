'use strict';

// Dedicated bulk handler for controlled Jellyfin server moves. Keep this
// separate from the bulk UI so every background migration goes through the
// same preflight, capacity, library and rollback controls as the single-user
// migration workflow.
const bulkWorker = require('../jellyfin/bulk-worker');
const serverMigration = require('../jellyfin/server-migration');
const { query } = require('../db');

bulkWorker.registerHandler('migrate_server', async item => {
    const targetServerId = String(item.params?.serverId || '').trim();
    if (!targetServerId) throw new Error('Choose a target Jellyfin server.');

    const migration = await serverMigration.createMigration(item.customer_id, targetServerId, null);
    const completed = await serverMigration.executeMigration(migration.id);
    if (!completed || completed.status !== 'succeeded') {
        throw new Error(completed?.last_error || 'The controlled server move did not complete.');
    }

    await query(`
        INSERT INTO audit_log(action,entity_type,entity_id,metadata)
        VALUES('admin.bulk.migrate_server','customer',$1,$2::jsonb)
    `, [item.customer_id, JSON.stringify({
        migrationId: migration.id,
        targetServerId,
        targetServerName: completed.target_server_name || null
    })]);

    return {
        migrationId: migration.id,
        targetServerId,
        targetServerName: completed.target_server_name || null,
        status: completed.status
    };
});

module.exports = {};
