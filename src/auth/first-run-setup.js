'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const { keyFromEnv } = require('../security/purpose-crypto');

const SETUP_LOCK_ID = '760045120260814';

class FirstRunValidationError extends Error {
    constructor(field, message) {
        super(message);
        this.name = 'FirstRunValidationError';
        this.field = field;
    }
}

function normalizeClaim(value) {
    return String(value || '').trim();
}

function claimHash(value) {
    const code = normalizeClaim(value);
    return crypto.createHmac('sha256', keyFromEnv('AUTH_ENCRYPTION_KEY'))
        .update(`steam-fusion:first-run:${code}`)
        .digest('hex');
}

function timingSafeHexEqual(leftValue, rightValue) {
    const left = Buffer.from(String(leftValue || ''), 'hex');
    const right = Buffer.from(String(rightValue || ''), 'hex');
    return left.length === 32 && right.length === 32 && crypto.timingSafeEqual(left, right);
}

function generateClaimCode() {
    return crypto.randomBytes(24).toString('base64url');
}

function cleanUsername(value) {
    const username = String(value || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
        throw new FirstRunValidationError('username', 'Username must be 3-40 characters using letters, numbers, dot, underscore or dash.');
    }
    return username;
}

function cleanEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return null;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new FirstRunValidationError('email', 'Enter a valid email address or leave it blank.');
    }
    return email;
}

function cleanSiteName(value) {
    const siteName = String(value || '').trim().replace(/\s+/g, ' ');
    if (siteName.length < 2 || siteName.length > 80 || /[\u0000-\u001f\u007f]/.test(siteName)) {
        throw new FirstRunValidationError('siteName', 'Site name must be between 2 and 80 visible characters.');
    }
    return siteName;
}

function validatePassword(password, confirmation) {
    const value = String(password || '');
    if (value.length < 8 || value.length > 200) {
        throw new FirstRunValidationError('password', 'Password must be between 8 and 200 characters.');
    }
    if (['admin123', 'password123', 'changeme1234'].includes(value.toLowerCase())) {
        throw new FirstRunValidationError('password', 'Choose a stronger password.');
    }
    if (value !== String(confirmation || '')) {
        throw new FirstRunValidationError('passwordConfirm', 'Password confirmation does not match.');
    }
    return value;
}

async function administratorCount(runner = { query }) {
    const result = await runner.query("SELECT COUNT(*)::int AS count FROM app_users WHERE role='admin'");
    return Number(result.rows[0]?.count || 0);
}

async function isSetupRequired() {
    return (await administratorCount()) === 0;
}

async function installationRow(runner) {
    const result = await runner.query("SELECT setting_value FROM platform_settings WHERE setting_key='installation' FOR UPDATE");
    return result.rows[0]?.setting_value && typeof result.rows[0].setting_value === 'object'
        ? result.rows[0].setting_value
        : {};
}

async function writeInstallation(runner, value) {
    await runner.query(`
        INSERT INTO platform_settings(setting_key,setting_value,updated_at)
        VALUES('installation',$1::jsonb,NOW())
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
    `, [JSON.stringify(value)]);
}

async function ensureClaimCode({ rotate = false } = {}) {
    return transaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(${SETUP_LOCK_ID})`);
        if (await administratorCount(client)) return { required: false, created: false, code: null };

        const installation = await installationRow(client);
        if (!rotate && installation.firstRunClaimHash) {
            return { required: true, created: false, code: null };
        }

        const code = generateClaimCode();
        installation.cleanInstall = installation.cleanInstall !== false;
        installation.setupVersion = Math.max(2, Number(installation.setupVersion || 0));
        installation.firstRunClaimHash = claimHash(code);
        installation.firstRunClaimCreatedAt = new Date().toISOString();
        delete installation.setupCompletedAt;
        await writeInstallation(client, installation);
        return { required: true, created: true, code };
    });
}

async function verifyClaimCode(value) {
    const code = normalizeClaim(value);
    if (!code || !(await isSetupRequired())) return false;
    const result = await query("SELECT setting_value->>'firstRunClaimHash' AS claim_hash FROM platform_settings WHERE setting_key='installation'");
    const expected = result.rows[0]?.claim_hash;
    return !!expected && timingSafeHexEqual(claimHash(code), expected);
}

async function completeSetup({ claimCode, username, email, password, passwordConfirm, siteName }) {
    const clean = {
        username: cleanUsername(username),
        email: cleanEmail(email),
        siteName: cleanSiteName(siteName),
        password: validatePassword(password, passwordConfirm)
    };
    const passwordHash = await bcrypt.hash(clean.password, 12);

    return transaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(${SETUP_LOCK_ID})`);
        if (await administratorCount(client)) {
            const error = new Error('First-run setup has already been completed.');
            error.code = 'SETUP_ALREADY_COMPLETED';
            throw error;
        }

        const installation = await installationRow(client);
        const expected = installation.firstRunClaimHash;
        if (!expected || !timingSafeHexEqual(claimHash(claimCode), expected)) {
            const error = new Error('The first-run setup code is invalid or has been rotated.');
            error.code = 'SETUP_CLAIM_INVALID';
            throw error;
        }

        const duplicate = await client.query(`
            SELECT username,email FROM app_users
            WHERE lower(username)=lower($1)
               OR ($2::text IS NOT NULL AND lower(COALESCE(email,''))=lower($2))
            LIMIT 1
        `, [clean.username, clean.email]);
        if (duplicate.rowCount) {
            if (String(duplicate.rows[0].username || '').toLowerCase() === clean.username.toLowerCase()) {
                throw new FirstRunValidationError('username', 'That username is already in use.');
            }
            throw new FirstRunValidationError('email', 'That email address is already in use.');
        }

        const legacyIdResult = await client.query(`
            SELECT COALESCE(MAX(legacy_numeric_id),0)::int + 1 AS next_id
            FROM app_users WHERE role='admin'
        `);
        const legacyId = Number(legacyIdResult.rows[0]?.next_id || 1);
        const inserted = await client.query(`
            INSERT INTO app_users(
                email,username,password_hash,role,active,legacy_numeric_id,is_owner,
                password_changed_at,email_verified_at,created_at,updated_at
            ) VALUES($1,$2,$3,'admin',TRUE,$4,TRUE,NOW(),CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END,NOW(),NOW())
            RETURNING id,email,username,role,active,legacy_numeric_id,is_owner,session_version,totp_enabled
        `, [clean.email, clean.username, passwordHash, legacyId]);
        const user = inserted.rows[0];

        await client.query(`
            INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
            VALUES('platform',jsonb_build_object('siteName',$1::text),$2,NOW())
            ON CONFLICT(setting_key) DO UPDATE
            SET setting_value=platform_settings.setting_value || jsonb_build_object('siteName',$1::text),
                updated_by=$2,updated_at=NOW()
        `, [clean.siteName, user.id]);

        installation.cleanInstall = installation.cleanInstall !== false;
        installation.setupVersion = Math.max(2, Number(installation.setupVersion || 0));
        installation.browserSetupCompleted = true;
        installation.setupCompletedAt = new Date().toISOString();
        installation.siteName = clean.siteName;
        delete installation.firstRunClaimHash;
        delete installation.firstRunClaimCreatedAt;
        await writeInstallation(client, installation);

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.first_run.created','app_user',$2,$3::jsonb)
        `, [user.id, String(user.id), JSON.stringify({
            username: clean.username,
            siteName: clean.siteName,
            legacyNumericId: legacyId,
            owner: true,
            source: 'browser_first_run'
        })]);

        return user;
    });
}

module.exports = {
    FirstRunValidationError,
    isSetupRequired,
    ensureClaimCode,
    verifyClaimCode,
    completeSetup,
    cleanUsername,
    cleanEmail,
    cleanSiteName,
    validatePassword
};
