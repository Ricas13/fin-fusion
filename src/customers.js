'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('./db');
const referrals = require('./referrals');

function cleanEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email || !email.includes('@') || email.length > 254) throw new Error('A valid email address is required');
    return email;
}

function cleanUsername(value) {
    const username = String(value || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
        throw new Error('Username must be 3-40 characters using letters, numbers, dot, underscore or dash');
    }
    return username;
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
        throw new Error('Password must be between 12 and 200 characters');
    }
}

async function registerCustomer({ email, username, password, referralCode }) {
    email = cleanEmail(email);
    username = cleanUsername(username);
    validatePassword(password);

    if (process.env.PUBLIC_REGISTRATION === 'false') {
        throw new Error('Public registration is currently disabled');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyImmediately = process.env.REQUIRE_EMAIL_VERIFICATION !== 'true';

    const created = await transaction(async client => {
        const exists = await client.query(
            'SELECT 1 FROM app_users WHERE lower(email)=lower($1) OR lower(username)=lower($2) LIMIT 1',
            [email, username]
        );
        if (exists.rowCount) throw new Error('An account already exists with that email or username');

        const userResult = await client.query(`
            INSERT INTO app_users(email,username,password_hash,role,email_verified_at)
            VALUES($1,$2,$3,'customer',CASE WHEN $4 THEN NOW() ELSE NULL END)
            RETURNING id,email,username,role,active,email_verified_at,created_at
        `, [email, username, passwordHash, verifyImmediately]);

        const user = userResult.rows[0];
        const customerResult = await client.query(`
            INSERT INTO customers(user_id,display_name,email)
            VALUES($1,$2,$3)
            RETURNING *
        `, [user.id, username, email]);

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'customer.register','customer',$2,$3::jsonb)
        `, [user.id, customerResult.rows[0].id, JSON.stringify({ emailVerified: verifyImmediately })]);

        return { user, customer: customerResult.rows[0] };
    });

    if (referralCode) {
        try {
            await referrals.attributeReferral(created.customer.id, referralCode);
        } catch (error) {
            console.error('Referral attribution failed:', error.message);
        }
    }
    return created;
}

async function authenticateCustomer(identity, password) {
    identity = String(identity || '').trim();
    if (!identity || typeof password !== 'string') return null;

    const result = await query(`
        SELECT u.id AS user_id,u.email,u.username,u.password_hash,u.active,u.email_verified_at,
               c.id AS customer_id,c.display_name
        FROM app_users u
        JOIN customers c ON c.user_id=u.id
        WHERE u.role='customer' AND (lower(u.email)=lower($1) OR lower(u.username)=lower($1))
        LIMIT 1
    `, [identity]);
    if (!result.rowCount || !result.rows[0].active) return null;

    const row = result.rows[0];
    if (!(await bcrypt.compare(password, row.password_hash))) return null;
    if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && !row.email_verified_at) {
        const error = new Error('Please verify your email address before signing in');
        error.code = 'EMAIL_NOT_VERIFIED';
        throw error;
    }

    await query('UPDATE app_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1', [row.user_id]);
    return {
        userId: row.user_id,
        customerId: row.customer_id,
        email: row.email,
        username: row.username,
        displayName: row.display_name
    };
}

async function getCustomerPortal(customerId) {
    const customerResult = await query(`
        SELECT c.*,u.email AS login_email,u.username AS login_username,u.email_verified_at
        FROM customers c LEFT JOIN app_users u ON u.id=c.user_id
        WHERE c.id=$1
    `, [customerId]);
    if (!customerResult.rowCount) return null;

    const subscriptions = await query(`
        SELECT s.*,p.code AS plan_code,p.name AS plan_name,p.streams,p.allow_downloads,
               p.allow_video_transcoding,p.allow_audio_transcoding,p.allow_live_tv,p.server_class
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.customer_id=$1 ORDER BY s.created_at DESC
    `, [customerId]);

    const accounts = await query(`
        SELECT ja.id,ja.jellyfin_username,ja.disabled,ja.last_activity_at,ja.last_policy_sync,
               js.name AS server_name,js.public_url,js.server_class
        FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.customer_id=$1 ORDER BY ja.created_at ASC
    `, [customerId]);

    const providers = await query(`
        SELECT pc.provider,pc.provider_customer_id
        FROM payment_customers pc WHERE pc.customer_id=$1
    `, [customerId]);

    const referralCode = await referrals.ensureReferralCode(customerId);

    return {
        customer: customerResult.rows[0],
        subscriptions: subscriptions.rows,
        accounts: accounts.rows,
        providers: providers.rows,
        referralCode
    };
}

async function listPublicPlans() {
    const result = await query(`
        SELECT p.*,
               COALESCE(jsonb_agg(
                   jsonb_build_object('provider',pp.provider,'checkoutMode',pp.checkout_mode,'configured',TRUE)
               ) FILTER (WHERE pp.id IS NOT NULL AND pp.active=TRUE),'[]'::jsonb) AS payment_options
        FROM plans p
        LEFT JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.active=TRUE AND p.visible=TRUE AND p.audience IN ('direct','both')
        GROUP BY p.id
        ORDER BY p.sort_order ASC,p.price_minor ASC
    `);
    return result.rows;
}

async function createAccountToken(userId, tokenType, ttlMinutes) {
    if (!['email_verify', 'password_reset'].includes(tokenType)) throw new Error('Unsupported token type');
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000);

    await transaction(async client => {
        await client.query(`
            UPDATE account_tokens SET consumed_at=NOW()
            WHERE user_id=$1 AND token_type=$2 AND consumed_at IS NULL
        `, [userId, tokenType]);
        await client.query(`
            INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at)
            VALUES($1,$2,$3,$4)
        `, [userId, tokenType, hash, expiresAt]);
    });
    return { token: raw, expiresAt };
}

async function consumeAccountToken(rawToken, tokenType) {
    const hash = crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
    return transaction(async client => {
        const found = await client.query(`
            SELECT * FROM account_tokens
            WHERE token_hash=$1 AND token_type=$2 AND consumed_at IS NULL AND expires_at>NOW()
            FOR UPDATE
        `, [hash, tokenType]);
        if (!found.rowCount) return null;
        await client.query('UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1', [found.rows[0].id]);
        return found.rows[0];
    });
}

async function verifyEmail(rawToken) {
    const token = await consumeAccountToken(rawToken, 'email_verify');
    if (!token) return false;
    await query('UPDATE app_users SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$1', [token.user_id]);
    return true;
}

async function resetSitePassword(rawToken, newPassword) {
    validatePassword(newPassword);
    const token = await consumeAccountToken(rawToken, 'password_reset');
    if (!token) return false;
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE app_users SET password_hash=$1,updated_at=NOW() WHERE id=$2', [passwordHash, token.user_id]);
    return true;
}

module.exports = {
    registerCustomer,
    authenticateCustomer,
    getCustomerPortal,
    listPublicPlans,
    createAccountToken,
    verifyEmail,
    resetSitePassword
};
