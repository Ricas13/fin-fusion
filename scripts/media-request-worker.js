'use strict';

require('dotenv').config();

const { getPool } = require('../src/db');
const mediaDispatch = require('../src/requests/media-dispatch');

const LOCK_KEY = 'steam-fusion:media-request-worker';
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 3600;

function intervalMs() {
    const parsed = Number(process.env.MEDIA_REQUEST_SYNC_SECONDS || DEFAULT_INTERVAL_SECONDS);
    const seconds = Number.isFinite(parsed)
        ? Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.floor(parsed)))
        : DEFAULT_INTERVAL_SECONDS;
    return seconds * 1000;
}

function log(message, details = null) {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console.log(`[media-request-worker] ${new Date().toISOString()} ${message}${suffix}`);
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    if (!process.env.ARR_ENCRYPTION_KEY) throw new Error('ARR_ENCRYPTION_KEY is required');
    if (process.env.NODE_ENV === 'production' && !String(process.env.ARR_ALLOWED_HOSTS || '').trim()) {
        throw new Error('ARR_ALLOWED_HOSTS is required in production');
    }

    const pool = getPool();
    const lockClient = await pool.connect();
    let ownsLock = false;
    let running = false;
    let stopping = false;
    const delay = intervalMs();

    lockClient.on('error', (error) => {
        console.error('[media-request-worker] PostgreSQL lock connection failed:', error.message);
        process.exitCode = 1;
        stopping = true;
    });

    async function ensureLock() {
        if (ownsLock) return true;
        const result = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_KEY]);
        ownsLock = Boolean(result.rows[0]?.locked);
        if (!ownsLock) log('Another worker owns the synchronization lock; remaining passive.');
        return ownsLock;
    }

    async function tick() {
        if (running || stopping) return;
        running = true;
        try {
            if (!(await ensureLock())) return;
            const result = await mediaDispatch.sync();
            log('Synchronization completed.', result);
        } catch (error) {
            console.error('[media-request-worker] Synchronization failed:', error.message);
        } finally {
            running = false;
        }
    }

    async function shutdown(signal) {
        if (stopping) return;
        stopping = true;
        log(`Received ${signal}; shutting down.`);
        try {
            if (ownsLock) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
        } catch (error) {
            console.error('[media-request-worker] Failed to release advisory lock:', error.message);
        } finally {
            lockClient.release();
            await pool.end().catch(() => {});
        }
    }

    process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
    process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));

    log('Started.', { intervalSeconds: delay / 1000 });
    await tick();
    const timer = setInterval(() => {
        tick().catch((error) => console.error('[media-request-worker] Tick failed:', error.message));
    }, delay);
    timer.unref?.();

    await new Promise((resolve) => {
        const keepAlive = setInterval(() => {
            if (stopping) {
                clearInterval(keepAlive);
                clearInterval(timer);
                resolve();
            }
        }, 1000);
    });
}

main().catch((error) => {
    console.error('[media-request-worker] Fatal startup error:', error.message);
    process.exit(1);
});
