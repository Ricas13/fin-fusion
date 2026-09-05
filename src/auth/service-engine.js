'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const { keyFromEnv, encryptWithEnv, decryptWithEnv } = require('../security/purpose-crypto');
const runtimeSettings = require('../platform/runtime-settings');
const totp = require('./totp');

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12);
const FAILURE_LIMIT = Math.max(3, Math.min(10, Number(process.env.AUTH_FAILURE_LIMIT || 5)));
const LOCK_MINUTES = Math.max(5, Math.min(60, Number(process.env.AUTH_LOCK_MINUTES || 15)));
const SESSION_HOURS = Math.max(1, Math.min(24, Number(process.env.STAFF_SESSION_HOURS || 12)));

function authEncrypt(value) {
    return value ? encryptWithEnv(String(value), 'AUTH_ENCRYPTION_KEY', 'authv1') : null;
}

function authDecrypt(value) {
    return value ? decryptWithEnv(value, 'AUTH_ENCRYPTION_KEY', 'authv1') : null;
}

function requestIp(req) {
    return req?.ip || req?.socket?.remoteAddress || null;
}

function userAgentHash(req) {
    return crypto.createHash('sha256').update(String(req?.get?.('user-agent') || '')).digest('hex');
}

function eventContext(req) {
    return {
        ipEncrypted: requestIp(req) ? authEncrypt(requestIp(req)) : null,
        userAgentHash: userAgentHash(req)
    };
}

async function recordEvent({ userId = null, identityHint = null, eventType, success = false, req = null, metadata = {} }, client = null) {
    const runner = client || { query };
    const ctx = req ? eventContext(req) : { ipEncrypted: null, userAgentHash: null };
    await runner.query(`
        INSERT INTO auth_events(user_id,identity_hint,event_type,success,ip_encrypted,user_agent_hash,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    `, [
        userId,
        identityHint ? String(identityHint).slice(0, 160) : null,
        eventType,
        !!success,
        ctx.ipEncrypted,
        ctx.userAgentHash,
        JSON.stringify(metadata || {})
    ]);
}

function validateNewPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
        throw new Error('Password must be between 8 and 200 characters');
    }
    const lowered = password.toLowerCase();
    if (['admin123', 'password123', 'changeme1234'].includes(lowered)) {
        throw new Error('Choose a stronger password');
    }
}

async function getStaffByIdentity(identity) {
    const clean = String(identity || '').trim();
    if (!clean) return null;
    const result = await query(`
        SELECT id,email,username,password_hash,role,active,legacy_numeric_id,
               totp_enabled,totp_secret_encrypted,totp_enrolled_at,
               failed_login_count,locked_until,last_login_at,password_changed_at,session_version
        FROM app_users
        WHERE role='admin'
          AND (lower(username)=lower($1) OR lower(COALESCE(email,''))=lower($1))
        LIMIT 1
    `, [clean]);
    return result.rows[0] || null;
}

async function getStaffById(userId) {
    const result = await query(`
        SELECT id,email,username,password_hash,role,active,legacy_numeric_id,
               totp_enabled,totp_secret_encrypted,totp_enrolled_at,
               failed_login_count,locked_until,last_login_at,password_changed_at,session_version
        FROM app_users
        WHERE id=$1 AND role='admin'
    `, [userId]);
    return result.rows[0] || null;
}

async function incrementFailureCounter(userId) {
    return transaction(async client => {
        const current = await client.query(`
            SELECT failed_login_count,locked_until
            FROM app_users
            WHERE id=$1 AND role='admin'
            FOR UPDATE
        `, [userId]);
        if (!current.rowCount) return { locked: true, failures: FAILURE_LIMIT, until: null };
        const row = current.rows[0];
        const now = Date.now();
        if (row.locked_until && new Date(row.locked_until).getTime() > now) {
            return { locked: true, failures: Number(row.failed_login_count || FAILURE_LIMIT), until: row.locked_until };
        }
        const previousExpiredLock = row.locked_until && new Date(row.locked_until).getTime() <= now;
        const failed = (previousExpiredLock ? 0 : Number(row.failed_login_count || 0)) + 1;
        const lock = failed >= FAILURE_LIMIT;
        const updated = await client.query(`
            UPDATE app_users
            SET failed_login_count=$2,
                locked_until=CASE WHEN $3 THEN NOW()+($4::text||' minutes')::interval ELSE NULL END,
                updated_at=NOW()
            WHERE id=$1
            RETURNING locked_until
        `, [userId, failed, lock, LOCK_MINUTES]);
        return { locked: lock, failures: failed, until: updated.rows[0]?.locked_until || null };
    });
}

async function clearFailureCounter(userId) {
    await query(`
        UPDATE app_users
        SET failed_login_count=0,locked_until=NULL,updated_at=NOW()
        WHERE id=$1 AND role='admin'
    `, [userId]);
}

async function authenticateStaff(identity, password, req) {
    await runtimeSettings.ensureLoaded().catch(() => {});
    const cleanIdentity = String(identity || '').trim().slice(0, 160);
    const supplied = typeof password === 'string' ? password : '';
    const user = await getStaffByIdentity(cleanIdentity);

    if (!user) {
        await bcrypt.compare(supplied, DUMMY_HASH);
        await recordEvent({ identityHint: cleanIdentity, eventType: 'login.password_failed', success: false, req });
        return null;
    }

    if (!user.active) {
        await bcrypt.compare(supplied, user.password_hash);
        await recordEvent({ userId: user.id, identityHint: cleanIdentity, eventType: 'login.inactive_account', success: false, req });
        return null;
    }

    const now = Date.now();
    if (user.locked_until && new Date(user.locked_until).getTime() > now) {
        await recordEvent({ userId: user.id, identityHint: cleanIdentity, eventType: 'login.account_locked', success: false, req });
        return null;
    }

    const passwordOk = await bcrypt.compare(supplied, user.password_hash);
    if (!passwordOk) {
        const failure = await incrementFailureCounter(user.id);
        await recordEvent({
            userId: user.id,
            identityHint: cleanIdentity,
            eventType: failure.locked ? 'login.account_locked' : 'login.password_failed',
            success: false,
            req,
            metadata: { failures: failure.failures }
        });
        return null;
    }

    const needsTwoFactor = requiresTwoFactor(user);
    const updated = await query(`
        UPDATE app_users
        SET failed_login_count=CASE WHEN $2 THEN failed_login_count ELSE 0 END,
            locked_until=CASE WHEN $2 THEN locked_until ELSE NULL END,
            last_login_at=NOW(),updated_at=NOW()
        WHERE id=$1
        RETURNING session_version,last_login_at
    `, [user.id, needsTwoFactor]);
    user.session_version = updated.rows[0].session_version;
    user.last_login_at = updated.rows[0].last_login_at;
    await recordEvent({ userId: user.id, identityHint: cleanIdentity, eventType: 'login.password_accepted', success: true, req });
    return user;
}

function requiresTwoFactor(user) {
    if (!user) return false;
    if (user.totp_enabled) return true;
    if (user.role === 'admin') return runtimeSettings.requireAdminTwoFactor();
    return false;
}

async function beginTotpEnrollment(userId) {
    const user = await getStaffById(userId);
    if (!user) throw new Error('Account not found');
    const secret = totp.generateSecret();
    const encrypted = authEncrypt(secret);
    await query(`
        INSERT INTO auth_totp_enrollments(user_id,secret_encrypted,expires_at)
        VALUES($1,$2,NOW()+INTERVAL '10 minutes')
        ON CONFLICT(user_id) DO UPDATE
        SET secret_encrypted=EXCLUDED.secret_encrypted,expires_at=EXCLUDED.expires_at,created_at=NOW()
    `, [userId, encrypted]);
    return {
        secret,
        uri: totp.otpauthUri({
            secret,
            accountName: user.email || user.username,
            issuer: process.env.SITE_NAME || 'CAPTAiNFiN'
        })
    };
}

function makeRecoveryCodes(count = 10) {
    return Array.from({ length: count }, () => {
        const raw = totp.base32Encode(crypto.randomBytes(10)).slice(0, 16);
        return raw.match(/.{1,4}/g).join('-');
    });
}

function normalizeRecoveryCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function recoveryHash(code) {
    return crypto.createHmac('sha256', keyFromEnv('AUTH_ENCRYPTION_KEY'))
        .update(`recovery:${normalizeRecoveryCode(code)}`)
        .digest('hex');
}

async function replaceRecoveryCodes(client, userId, codes) {
    await client.query('DELETE FROM auth_recovery_codes WHERE user_id=$1', [userId]);
    for (const code of codes) {
        await client.query(
            'INSERT INTO auth_recovery_codes(user_id,code_hash) VALUES($1,$2)',
            [userId, recoveryHash(code)]
        );
    }
}

async function confirmTotpEnrollment(userId, code, req) {
    const result = await query(`
        SELECT secret_encrypted FROM auth_totp_enrollments
        WHERE user_id=$1 AND expires_at>NOW()
    `, [userId]);
    if (!result.rowCount) throw new Error('The setup session expired. Start 2FA setup again.');
    const secret = authDecrypt(result.rows[0].secret_encrypted);
    if (!totp.verifyTotp(secret, code)) {
        await recordEvent({ userId, eventType: '2fa.enrollment_failed', success: false, req });
        return null;
    }

    const recoveryCodes = makeRecoveryCodes();
    await transaction(async client => {
        await client.query(`
            UPDATE app_users
            SET totp_enabled=TRUE,totp_secret_encrypted=$2,totp_enrolled_at=NOW(),updated_at=NOW()
            WHERE id=$1
        `, [userId, authEncrypt(secret)]);
        await replaceRecoveryCodes(client, userId, recoveryCodes);
        await client.query('DELETE FROM auth_totp_enrollments WHERE user_id=$1', [userId]);
        await recordEvent({ userId, eventType: '2fa.enrolled', success: true, req }, client);
    });
    return recoveryCodes;
}

async function disableTotp(userId, currentPassword, req) {
    const user = await getStaffById(userId);
    if (!user || !user.totp_enabled) return false;
    if (!(await bcrypt.compare(String(currentPassword || ''), user.password_hash))) {
        await recordEvent({ userId, eventType: '2fa.disable_failed', success: false, req });
        return false;
    }
    return transaction(async client => {
        const locked = await client.query(`
            SELECT password_hash,totp_enabled
            FROM app_users
            WHERE id=$1 AND role='admin'
            FOR UPDATE
        `, [userId]);
        if (!locked.rowCount || !locked.rows[0].totp_enabled || locked.rows[0].password_hash !== user.password_hash) {
            await recordEvent({ userId, eventType: '2fa.disable_failed', success: false, req }, client);
            return false;
        }
        await client.query(`
            UPDATE app_users
            SET totp_enabled=FALSE,totp_secret_encrypted=NULL,totp_enrolled_at=NULL,updated_at=NOW()
            WHERE id=$1
        `, [userId]);
        await client.query('DELETE FROM auth_recovery_codes WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM auth_totp_enrollments WHERE user_id=$1', [userId]);
        await recordEvent({ userId, eventType: '2fa.disabled', success: true, req }, client);
        return true;
    });
}

async function verifySecondFactor(userId, token, req) {
    const user = await getStaffById(userId);
    if (!user) return false;
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        await recordEvent({ userId, eventType: '2fa.challenge_locked', success: false, req });
        return false;
    }

    if (req?.session?.authUserId && String(req.session.authUserId) === String(userId) && !req.session?.pendingStaffAuth) {
        await recordEvent({
            userId,
            eventType: '2fa.step_up_not_required',
            success: true,
            req,
            metadata: { policy: 'login_only', enrolled: !!user.totp_enabled }
        });
        return true;
    }

    if (!user.totp_enabled && !requiresTwoFactor(user)) {
        await recordEvent({
            userId,
            eventType: '2fa.step_up_not_required',
            success: true,
            req,
            metadata: { policy: 'optional', enrolled: false }
        });
        return true;
    }

    if (!user.totp_enabled || !user.totp_secret_encrypted) return false;
    const value = String(token || '').trim();
    const secret = authDecrypt(user.totp_secret_encrypted);

    if (/^\d{6}$/.test(value.replace(/\s+/g, ''))) {
        const ok = totp.verifyTotp(secret, value);
        if (ok) {
            await clearFailureCounter(userId);
            await recordEvent({ userId, eventType: '2fa.totp_accepted', success: true, req });
            return true;
        }
        const failure = await incrementFailureCounter(userId);
        await recordEvent({ userId, eventType: failure.locked ? '2fa.challenge_locked' : '2fa.totp_failed', success: false, req, metadata: { failures: failure.failures } });
        return false;
    }

    const hash = recoveryHash(value);
    const used = await query(`
        UPDATE auth_recovery_codes
        SET used_at=NOW()
        WHERE id=(
            SELECT id FROM auth_recovery_codes
            WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id
    `, [userId, hash]);
    const ok = used.rowCount === 1;
    if (ok) {
        await clearFailureCounter(userId);
        await recordEvent({ userId, eventType: '2fa.recovery_accepted', success: true, req });
        return true;
    }
    const failure = await incrementFailureCounter(userId);
    await recordEvent({ userId, eventType: failure.locked ? '2fa.challenge_locked' : '2fa.recovery_failed', success: false, req, metadata: { failures: failure.failures } });
    return false;
}

async function lockAfterSecondFactorFailures(userId, req) {
    await query(`
        UPDATE app_users
        SET failed_login_count=GREATEST(failed_login_count,$2),locked_until=NOW()+($3::text || ' minutes')::interval,updated_at=NOW()
        WHERE id=$1
    `, [userId, FAILURE_LIMIT, LOCK_MINUTES]);
    await recordEvent({ userId, eventType: '2fa.challenge_locked', success: false, req });
}

async function registerSession(req, user) {
    const ctx = eventContext(req);
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    await query(`
        INSERT INTO auth_sessions(session_id,user_id,role,session_version,ip_encrypted,user_agent_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(session_id) DO UPDATE
        SET user_id=EXCLUDED.user_id,role=EXCLUDED.role,session_version=EXCLUDED.session_version,
            ip_encrypted=EXCLUDED.ip_encrypted,user_agent_hash=EXCLUDED.user_agent_hash,
            last_seen_at=NOW(),expires_at=EXCLUDED.expires_at,revoked_at=NULL
    `, [req.sessionID, user.id, user.role, user.session_version, ctx.ipEncrypted, ctx.userAgentHash, expiresAt]);
    await recordEvent({ userId: user.id, eventType: 'login.session_created', success: true, req });
}

async function validateStaffSession(req) {
    if (!req.session?.authUserId || req.session?.authRole !== 'admin') return { valid: true };
    const result = await query(`
        SELECT s.session_id,s.session_version,s.user_agent_hash,s.last_seen_at,s.expires_at,s.revoked_at,
               u.id AS user_id,u.role,u.active,u.session_version AS current_session_version
        FROM auth_sessions s
        JOIN app_users u ON u.id=s.user_id
        WHERE s.session_id=$1 AND s.user_id=$2
    `, [req.sessionID, req.session.authUserId]);
    if (!result.rowCount) return { valid: false, reason: 'session_not_registered' };
    const row = result.rows[0];
    if (!row.active || row.revoked_at || new Date(row.expires_at) <= new Date()) return { valid: false, reason: 'session_inactive' };
    if (Number(row.session_version) !== Number(row.current_session_version) || Number(req.session.authSessionVersion) !== Number(row.current_session_version)) {
        return { valid: false, reason: 'session_version_mismatch' };
    }
    const currentUaHash = userAgentHash(req);
    if (row.user_agent_hash && currentUaHash !== row.user_agent_hash) {
        await query('UPDATE auth_sessions SET revoked_at=NOW() WHERE session_id=$1', [req.sessionID]);
        await recordEvent({ userId: row.user_id, eventType: 'session.user_agent_changed', success: false, req });
        return { valid: false, reason: 'user_agent_changed' };
    }
    if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) {
        await query('UPDATE auth_sessions SET last_seen_at=NOW() WHERE session_id=$1', [req.sessionID]);
    }
    return { valid: true, userId: row.user_id, role: row.role };
}

async function listSessions(userId) {
    const result = await query(`
        SELECT session_id,role,user_agent_hash,created_at,last_seen_at,expires_at,revoked_at
        FROM auth_sessions
        WHERE user_id=$1
        ORDER BY last_seen_at DESC
        LIMIT 50
    `, [userId]);
    return result.rows;
}

async function revokeOtherSessions(userId, currentSessionId, req) {
    await transaction(async client => {
        const found = await client.query(`
            SELECT session_id FROM auth_sessions
            WHERE user_id=$1 AND session_id<>$2 AND revoked_at IS NULL
        `, [userId, currentSessionId]);
        const ids = found.rows.map(row => row.session_id);
        await client.query(`
            UPDATE auth_sessions SET revoked_at=NOW()
            WHERE user_id=$1 AND session_id<>$2 AND revoked_at IS NULL
        `, [userId, currentSessionId]);
        if (ids.length) await client.query('DELETE FROM user_sessions WHERE sid = ANY($1::text[])', [ids]);
        await recordEvent({ userId, eventType: 'session.revoke_others', success: true, req, metadata: { count: ids.length } }, client);
    });
}

async function markSessionLoggedOut(sessionId, userId, req) {
    if (!sessionId || !userId) return;
    await query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE session_id=$1 AND user_id=$2', [sessionId, userId]);
    await recordEvent({ userId, eventType: 'session.logout', success: true, req });
}

async function changePassword(userId, currentPassword, newPassword, currentSessionId, req) {
    validateNewPassword(newPassword);
    const user = await getStaffById(userId);
    if (!user || !(await bcrypt.compare(String(currentPassword || ''), user.password_hash))) {
        await recordEvent({ userId, eventType: 'password.change_failed', success: false, req });
        return null;
    }
    if (await bcrypt.compare(newPassword, user.password_hash)) throw new Error('New password must be different from the current password');
    const hash = await bcrypt.hash(newPassword, 12);
    return transaction(async client => {
        const updated = await client.query(`
            UPDATE app_users
            SET password_hash=$2,password_changed_at=NOW(),session_version=session_version+1,
                failed_login_count=0,locked_until=NULL,updated_at=NOW()
            WHERE id=$1 AND password_hash=$3
            RETURNING session_version,password_changed_at
        `, [userId, hash, user.password_hash]);
        if (!updated.rowCount) {
            await recordEvent({ userId, eventType: 'password.change_failed', success: false, req, metadata: { reason: 'credential_changed_concurrently' } }, client);
            return null;
        }
        const version = updated.rows[0].session_version;
        await client.query(`
            UPDATE auth_sessions SET revoked_at=NOW()
            WHERE user_id=$1 AND session_id<>$2 AND revoked_at IS NULL
        `, [userId, currentSessionId]);
        await client.query(`
            UPDATE auth_sessions SET session_version=$3,last_seen_at=NOW()
            WHERE user_id=$1 AND session_id=$2
        `, [userId, currentSessionId, version]);
        const other = await client.query('SELECT session_id FROM auth_sessions WHERE user_id=$1 AND session_id<>$2', [userId, currentSessionId]);
        const ids = other.rows.map(row => row.session_id);
        if (ids.length) await client.query('DELETE FROM user_sessions WHERE sid = ANY($1::text[])', [ids]);
        await recordEvent({ userId, eventType: 'password.changed', success: true, req }, client);
        return { sessionVersion: version, passwordChangedAt: updated.rows[0].password_changed_at };
    });
}

async function regenerateRecoveryCodes(userId, currentTotpCode, req) {
    const user = await getStaffById(userId);
    if (!user || !user.totp_enabled) throw new Error('Two-factor authentication is not enabled');
    const secret = authDecrypt(user.totp_secret_encrypted);
    if (!totp.verifyTotp(secret, currentTotpCode)) {
        await recordEvent({ userId, eventType: '2fa.recovery_regeneration_failed', success: false, req });
        return null;
    }
    const codes = makeRecoveryCodes();
    await transaction(async client => {
        await client.query(`SELECT id FROM app_users WHERE id=$1 AND role='admin' FOR UPDATE`, [userId]);
        await replaceRecoveryCodes(client, userId, codes);
        await recordEvent({ userId, eventType: '2fa.recovery_regenerated', success: true, req }, client);
    });
    return codes;
}

async function getSecurityOverview(userId) {
    const userResult = await query(`
        SELECT id,username,email,role,active,totp_enabled,totp_enrolled_at,last_login_at,
               password_changed_at,locked_until,failed_login_count,session_version
        FROM app_users WHERE id=$1
    `, [userId]);
    if (!userResult.rowCount) return null;
    const recovery = await query(`
        SELECT COUNT(*)::int AS remaining
        FROM auth_recovery_codes WHERE user_id=$1 AND used_at IS NULL
    `, [userId]);
    const events = await query(`
        SELECT event_type,success,metadata,created_at
        FROM auth_events WHERE user_id=$1
        ORDER BY created_at DESC LIMIT 50
    `, [userId]);
    return {
        user: userResult.rows[0],
        recoveryCodesRemaining: recovery.rows[0].remaining,
        sessions: await listSessions(userId),
        events: events.rows
    };
}

module.exports = {
    authenticateStaff,
    getStaffById,
    requiresTwoFactor,
    beginTotpEnrollment,
    confirmTotpEnrollment,
    disableTotp,
    verifySecondFactor,
    lockAfterSecondFactorFailures,
    registerSession,
    validateStaffSession,
    listSessions,
    revokeOtherSessions,
    markSessionLoggedOut,
    changePassword,
    regenerateRecoveryCodes,
    getSecurityOverview,
    recordEvent,
    validateNewPassword
};