'use strict';

// Stable PostgreSQL advisory-lock keys. Restore uses the maintenance lock
// exclusively; normal application/worker mutations use its shared counterpart.
// Backup creation/verification additionally serialize on BACKUP_OPERATION_LOCK.
const RESTORE_MAINTENANCE_LOCK = '741039441001';
const BACKUP_OPERATION_LOCK = '741039441002';

module.exports = { RESTORE_MAINTENANCE_LOCK, BACKUP_OPERATION_LOCK };
