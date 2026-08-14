'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('./db');
const { encryptString, decryptString } = require('./crypto');

function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function cleanEmail(value, required = false) {
    const email = String(value || '').trim().toLowerCase();
    if (!email && !required) return null;
    if (!email || !email.includes('@') || email.length > 254) throw new Error('Enter a valid email address.');
    return email;
}
function cleanUsername(value) {
    const username = String(value || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new Error('Username must be 3–40 characters using letters, numbers, dot, underscore or dash.');
    return username;
}
function validatePassword(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 200) throw new Error('Password must be between 12 and 200 characters.');
}
function cleanTtlHours(value) {
    const hours = Number.parseInt(String(value || '168'), 10);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) throw new Error('Claim expiry must be between 1 hour and 30 days.');
    return hours;
}
function claimStatus(row, now = new Date()) {
    if (!row) return 'missing';
    if (row.consumed_at) return 'claimed';
    if (row.revoked_at) return 'revoked';
    if (new Date(row.expires_at) <= now) return 'expired';
    return 'active';
}
function decryptToken(value) {
    if (!value) return null;
    try { return decryptString(value); } catch (_) { return null; }
}

async function customerIdentity(customerId) {
    const result = await query(`
        SELECT c.id,c.user_id,c.display_name,c.email,
               COALESCE((
                   SELECT ja.jellyfin_username FROM jellyfin_accounts ja
                   WHERE ja.customer_id=c.id
                   ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC LIMIT 1
               ),c.display_name) AS suggested_username,
               COALESCE((
                   SELECT string_agg(DISTINCT ja.jellyfin_username, ', ' ORDER BY ja.jellyfin_username)
                   FROM jellyfin_accounts ja WHERE ja.customer_id=c.id
               ),'') AS jellyfin_usernames,
               COALESCE((
                   SELECT string_agg(DISTINCT js.name, ', ' ORDER BY js.name)
                   FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
                   WHERE ja.customer_id=c.id
               ),'') AS server_names
        FROM customers c WHERE c.id=$1
    `, [customerId]);
    return result.rows[0] || null;
}

async function createClaim({ customerId, emailLock = null, ttlHours = 168, actorUserId = null }) {
    const customer = await customerIdentity(customerId);
    if (!customer) throw new Error('Customer not found.');
    if (customer.user_id) throw new Error('This customer already has a CAPTaINFiN portal account.');
    const lockedEmail = cleanEmail(emailLock, false);
    const hours = cleanTtlHours(ttlHours);
    const token = newToken();
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const created = await transaction(async client => {
        await client.query(`
            UPDATE customer_account_claims
            SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
            WHERE customer_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL
        `, [customerId]);
        const result = await client.query(`
            INSERT INTO customer_account_claims(customer_id,token_hash,token_encrypted,email_lock,expires_at,created_by)
            VALUES($1,$2,$3,$4,$5,$6)
            RETURNING *
        `, [customerId, hashToken(token), encryptString(token), lockedEmail, expiresAt, actorUserId]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'customer.claim_link.create','customer',$2,$3::jsonb)
        `, [actorUserId, customerId, JSON.stringify({ claimId: result.rows[0].id, emailLock: lockedEmail, expiresAt })]);
        return result.rows[0];
    });
    return { claim: created, token, customer };
}

async function revokeClaim({ claimId, actorUserId = null }) {
    const result = await query(`
        UPDATE customer_account_claims
        SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
        WHERE id=$1 AND consumed_at IS NULL
        RETURNING customer_id
    `, [claimId]);
    if (!result.rowCount) throw new Error('Active claim link not found.');
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'customer.claim_link.revoke','customer',$2,$3::jsonb)
    `, [actorUserId, result.rows[0].customer_id, JSON.stringify({ claimId })]);
    return true;
}

async function lookupClaim(rawToken) {
    const result = await query(`
        SELECT cc.*,c.user_id,c.display_name,c.email AS customer_email,
               COALESCE((
                   SELECT ja.jellyfin_username FROM jellyfin_accounts ja
                   WHERE ja.customer_id=c.id
                   ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC LIMIT 1
               ),c.display_name) AS suggested_username,
               COALESCE((
                   SELECT string_agg(DISTINCT ja.jellyfin_username, ', ' ORDER BY ja.jellyfin_username)
                   FROM jellyfin_accounts ja WHERE ja.customer_id=c.id
               ),'') AS jellyfin_usernames,
               COALESCE((
                   SELECT string_agg(DISTINCT js.name, ', ' ORDER BY js.name)
                   FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
                   WHERE ja.customer_id=c.id
               ),'') AS server_names
        FROM customer_account_claims cc
        JOIN customers c ON c.id=cc.customer_id
        WHERE cc.token_hash=$1
        LIMIT 1
    `, [hashToken(rawToken)]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { ...row, status: row.user_id ? 'claimed' : claimStatus(row) };
}

async function redeemClaim({ token, username, email = null, password }) {
    username = cleanUsername(username);
    validatePassword(password);
    const passwordHash = await bcrypt.hash(password, 12);
    const tokenHash = hashToken(token);

    return transaction(async client => {
        const found = await client.query(`
            SELECT cc.*,c.user_id,c.display_name,c.email AS customer_email
            FROM customer_account_claims cc
            JOIN customers c ON c.id=cc.customer_id
            WHERE cc.token_hash=$1
            FOR UPDATE OF cc,c
        `, [tokenHash]);
        if (!found.rowCount) throw new Error('This claim link is invalid.');
        const claim = found.rows[0];
        if (claim.user_id || claim.consumed_at) throw new Error('This account has already been claimed.');
        if (claim.revoked_at) throw new Error('This claim link has been revoked.');
        if (new Date(claim.expires_at) <= new Date()) throw new Error('This claim link has expired.');

        const claimEmail = claim.email_lock ? cleanEmail(claim.email_lock, true) : cleanEmail(email, false);
        if (claim.email_lock && email && cleanEmail(email, true) !== claimEmail) throw new Error('This claim link is assigned to a different email address.');

        const duplicate = await client.query(`
            SELECT username,email FROM app_users
            WHERE lower(username)=lower($1)
               OR ($2::text IS NOT NULL AND lower(COALESCE(email,''))=lower($2))
            LIMIT 1
        `, [username, claimEmail]);
        if (duplicate.rowCount) throw new Error('That username or email is already in use.');

        const userResult = await client.query(`
            INSERT INTO app_users(email,username,password_hash,role,active,email_verified_at,password_changed_at)
            VALUES($1,$2,$3,'customer',TRUE,CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END,NOW())
            RETURNING id,email,username,role,active,email_verified_at
        `, [claimEmail, username, passwordHash]);
        const user = userResult.rows[0];

        const customerResult = await client.query(`
            UPDATE customers
            SET user_id=$2,
                display_name=COALESCE(NULLIF(display_name,''),$3),
                email=COALESCE($4,email),
                updated_at=NOW()
            WHERE id=$1 AND user_id IS NULL
            RETURNING *
        `, [claim.customer_id, user.id, username, claimEmail]);
        if (!customerResult.rowCount) throw new Error('This account has already been claimed.');

        await client.query(`
            UPDATE customer_account_claims
            SET consumed_at=NOW(),claimed_user_id=$2,updated_at=NOW()
            WHERE id=$1
        `, [claim.id, user.id]);
        await client.query(`
            UPDATE customer_account_claims
            SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
            WHERE customer_id=$1 AND id<>$2 AND consumed_at IS NULL AND revoked_at IS NULL
        `, [claim.customer_id, claim.id]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'customer.claim.complete','customer',$2,$3::jsonb)
        `, [user.id, claim.customer_id, JSON.stringify({ claimId: claim.id, username, emailSet: Boolean(claimEmail), jellyfinPasswordChanged: false })]);

        return { user, customer: customerResult.rows[0], claim };
    });
}

async function listAdminClaims() {
    const result = await query(`
        SELECT c.id AS customer_id,c.display_name,c.email,c.user_id,
               u.username AS portal_username,u.last_login_at,
               COALESCE((SELECT string_agg(DISTINCT ja.jellyfin_username, ', ' ORDER BY ja.jellyfin_username) FROM jellyfin_accounts ja WHERE ja.customer_id=c.id),'') AS jellyfin_usernames,
               COALESCE((SELECT string_agg(DISTINCT js.name, ', ' ORDER BY js.name) FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=c.id),'') AS server_names,
               cc.id AS claim_id,cc.token_encrypted,cc.email_lock,cc.expires_at,cc.consumed_at,cc.revoked_at,cc.created_at AS claim_created_at
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN LATERAL (
            SELECT * FROM customer_account_claims x
            WHERE x.customer_id=c.id
            ORDER BY x.created_at DESC LIMIT 1
        ) cc ON TRUE
        WHERE EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=c.id)
        ORDER BY (c.user_id IS NULL) DESC,c.created_at DESC
    `);
    return result.rows.map(row => ({
        ...row,
        claim_status: row.claim_id ? claimStatus(row) : 'none',
        raw_token: row.claim_id && claimStatus(row) === 'active' ? decryptToken(row.token_encrypted) : null
    }));
}

module.exports = {
    hashToken,
    claimStatus,
    customerIdentity,
    createClaim,
    revokeClaim,
    lookupClaim,
    redeemClaim,
    listAdminClaims
};
