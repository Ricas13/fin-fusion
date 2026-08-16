'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Client } = require('pg');
const { parseHeaderFromFd, requireBackupKey } = require('../src/backup/encrypted-stream');
const { postgresProcessEnv } = require('../src/backup/postgres-env');
const { query, getPool } = require('../src/db');

function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', code => code === 0
            ? resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
            : reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString().slice(-3000)}`)));
    });
}

function dbUrlFor(base, name) {
    const url = new URL(base);
    url.pathname = `/${name}`;
    return url.toString();
}

async function latestBackup() {
    const result = await query(`SELECT * FROM backup_runs WHERE status='succeeded' AND file_path IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
    return result.rows[0] || null;
}

async function mark(id, ok, note) {
    if (!id) return;
    await query(`UPDATE backup_runs
        SET verified_at=CASE WHEN $2 THEN NOW() ELSE verified_at END,
            verification_note=$3,
            metadata=metadata||$4::jsonb
        WHERE id=$1`, [
        id,
        Boolean(ok),
        String(note || '').slice(0, 2000),
        JSON.stringify({ lastVerificationAttemptAt: new Date().toISOString(), lastVerificationOk: Boolean(ok) })
    ]);
}

function openBackupDescriptor(filePath) {
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
        fs.closeSync(fd);
        throw new Error('Backup path is not a regular file.');
    }
    return { fd, stat };
}

async function main() {
    requireBackupKey();
    const verifierBase = String(process.env.BACKUP_VERIFY_DATABASE_URL || '').trim();
    if (!verifierBase) throw new Error('BACKUP_VERIFY_DATABASE_URL is required for restore verification');
    const verifier = new URL(verifierBase);
    if (!['postgres:', 'postgresql:'].includes(verifier.protocol)) throw new Error('BACKUP_VERIFY_DATABASE_URL must be PostgreSQL');
    if (decodeURIComponent(verifier.username || '') !== 'steamfusion_backup_verify') {
        throw new Error('BACKUP_VERIFY_DATABASE_URL must authenticate as steamfusion_backup_verify');
    }

    const record = process.argv[2] ? null : await latestBackup();
    const inputValue = process.argv[2] || record?.file_path || '';
    if (!inputValue) throw new Error('Backup file not found. Pass a .pgdump.enc path or create a managed backup first.');
    const input = path.resolve(inputValue);
    let opened;
    try { opened = openBackupDescriptor(input); }
    catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Backup file not found. Pass a .pgdump.enc path or create a managed backup first.');
        throw error;
    }
    const { fd: inputFd, stat: inputStat } = opened;

    const runId = record?.id || (await query(
        `SELECT id FROM backup_runs WHERE file_path=$1 OR file_name=$2 ORDER BY started_at DESC LIMIT 1`,
        [input, path.basename(input)]
    )).rows[0]?.id || null;

    const restoreRoot = path.resolve(process.env.BACKUP_RESTORE_TMPDIR || os.tmpdir());
    fs.mkdirSync(restoreRoot, { recursive: true, mode: 0o700 });
    const tempDir = fs.mkdtempSync(path.join(restoreRoot, 'captainfin-verify-'));
    const plain = path.join(tempDir, 'restore.pgdump');
    const databaseName = `captainfin_verify_${crypto.randomBytes(6).toString('hex')}`;
    const adminUrl = dbUrlFor(verifierBase, 'postgres');
    const verifyUrl = dbUrlFor(verifierBase, databaseName);
    const admin = new Client({ connectionString: adminUrl });
    let created = false;

    try {
        // Header, size, authentication tag and ciphertext all come from the same
        // descriptor opened with O_NOFOLLOW. No check-then-reopen path remains for
        // an attacker to swap between validation and decryption.
        const { header, headerBytes, salt, iv } = parseHeaderFromFd(inputFd);
        if (inputStat.size <= headerBytes + 16) throw new Error('Encrypted backup is truncated.');
        const tag = Buffer.alloc(16);
        fs.readSync(inputFd, tag, 0, tag.length, inputStat.size - tag.length);
        const secret = requireBackupKey();
        const key = crypto.scryptSync(secret, salt, 32, { N: 16384 });
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAAD(header);
        decipher.setAuthTag(tag);
        const cipherStart = headerBytes;
        const cipherEnd = inputStat.size - tag.length - 1;

        await pipeline(
            fs.createReadStream(input, { fd: inputFd, autoClose: false, start: cipherStart, end: cipherEnd }),
            decipher,
            fs.createWriteStream(plain, { mode: 0o600 })
        );

        await run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', plain], process.env);
        await admin.connect();
        await admin.query(`CREATE DATABASE ${databaseName}`);
        created = true;

        // Keep the verifier password out of the process argument list. libpq gets
        // the dedicated temp-database credential through PG* environment values.
        await run(
            process.env.PG_RESTORE_BIN || 'pg_restore',
            ['--no-owner', '--no-privileges', '--dbname', databaseName, plain],
            postgresProcessEnv(verifyUrl)
        );

        const verify = new Client({ connectionString: verifyUrl });
        await verify.connect();
        const schema = await verify.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
        const migrations = await verify.query(`SELECT to_regclass('public.schema_migrations') present`);
        await verify.end();
        if (Number(schema.rows[0]?.n || 0) < 5 || !migrations.rows[0]?.present) {
            throw new Error('Restored database did not contain the expected CAPTaINFiN schema.');
        }
        const note = `Full temporary restore succeeded into ${databaseName}; ${schema.rows[0].n} public tables detected.`;
        await mark(runId, true, note);
        console.log(note);
    } catch (error) {
        await mark(runId, false, error.message).catch(() => {});
        throw error;
    } finally {
        try { fs.closeSync(inputFd); } catch (_) {}
        if (created) {
            try {
                if (!admin._connected) await admin.connect();
                await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
            } catch (error) {
                console.warn('Temporary verification database cleanup failed:', error.message);
            }
        }
        try { await admin.end(); } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        try { await getPool().end(); } catch (_) {}
    }
}

main().catch(error => {
    console.error(`Backup verification failed: ${error.message}`);
    process.exit(1);
});
