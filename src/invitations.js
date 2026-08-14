'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('./db');
const provisioning = require('./jellyfin/provisioning');

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken || ''), 'utf8').digest('hex');
}

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function cleanEmail(value, { required = true } = {}) {
    const email = String(value || '').trim().toLowerCase();
    if (!email && !required) return null;
    if (!email || !email.includes('@') || email.length > 254) throw new Error('Enter a valid email address');
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

function statusFor(invitation, now = new Date()) {
    if (invitation?.revoked_at) return 'revoked';
    if (!invitation?.expires_at || new Date(invitation.expires_at) <= now) return 'expired';
    const uses = Number(invitation.use_count || 0);
    if (invitation.single_use && uses > 0) return 'used';
    if (!invitation.single_use && uses > 0) return 'active';
    return 'pending';
}

function publicInvitation(row) {
    if (!row) return null;
    return {
        id: row.id,
        planId: row.plan_id,
        planName: row.plan_name,
        planCode: row.plan_code,
        billingInterval: row.billing_interval,
        durationDays: row.duration_days,
        invitedEmail: row.invited_email,
        singleUse: Boolean(row.single_use),
        expiresAt: row.expires_at,
        useCount: Number(row.use_count || 0),
        status: statusFor(row)
    };
}

async function createInvitation({ planId, email = null, ttlHours = 72, singleUse = true, actorUserId }) {
    const hours = Number.parseInt(String(ttlHours), 10);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 90) {
        throw new Error('Invitation expiry must be between 1 hour and 90 days');
    }
    const invitedEmail = cleanEmail(email, { required: false });
    const plan = await query('SELECT id,name,active FROM plans WHERE id=$1', [planId]);
    if (!plan.rowCount) throw new Error('Plan not found');
    if (!plan.rows[0].active) throw new Error('Archived plans cannot be used for new invitations');

    const token = newToken();
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const created = await query(`
        INSERT INTO customer_invitations(plan_id,token_hash,invited_email,single_use,expires_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING id,plan_id,invited_email,single_use,expires_at,created_at
    `, [planId, hashToken(token), invitedEmail, Boolean(singleUse), expiresAt, actorUserId || null]);

    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'invitation.create','invitation',$2,$3::jsonb)
    `, [actorUserId || null, created.rows[0].id, JSON.stringify({
        planId,
        invitedEmail,
        singleUse: Boolean(singleUse),
        expiresAt
    })]);

    return { invitation: created.rows[0], token };
}

async function listInvitations() {
    const result = await query(`
        SELECT i.id,i.plan_id,i.invited_email,i.single_use,i.expires_at,i.revoked_at,
               i.created_by,i.created_at,i.updated_at,
               p.name AS plan_name,p.code AS plan_code,p.active AS plan_active,
               COUNT(r.id)::int AS use_count,
               MAX(r.redeemed_at) AS last_redeemed_at
        FROM customer_invitations i
        JOIN plans p ON p.id=i.plan_id
        LEFT JOIN invitation_redemptions r ON r.invitation_id=i.id
        GROUP BY i.id,p.id
        ORDER BY i.created_at DESC
    `);
    return result.rows.map(row => ({ ...row, status: statusFor(row) }));
}

async function lookupInvitation(rawToken) {
    const result = await query(`
        SELECT i.*,p.name AS plan_name,p.code AS plan_code,p.billing_interval,p.duration_days,p.active AS plan_active,
               COUNT(r.id)::int AS use_count
        FROM customer_invitations i
        JOIN plans p ON p.id=i.plan_id
        LEFT JOIN invitation_redemptions r ON r.invitation_id=i.id
        WHERE i.token_hash=$1
        GROUP BY i.id,p.id
    `, [hashToken(rawToken)]);
    if (!result.rowCount) return null;
    return publicInvitation(result.rows[0]);
}

async function revokeInvitation(invitationId, actorUserId) {
    const result = await query(`
        UPDATE customer_invitations
        SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
        WHERE id=$1
        RETURNING id
    `, [invitationId]);
    if (!result.rowCount) throw new Error('Invitation not found');
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id)
        VALUES($1,'invitation.revoke','invitation',$2)
    `, [actorUserId || null, invitationId]);
    return true;
}

async function rotateInvitation(invitationId, actorUserId) {
    const current = await query(`
        SELECT i.*,COUNT(r.id)::int AS use_count
        FROM customer_invitations i
        LEFT JOIN invitation_redemptions r ON r.invitation_id=i.id
        WHERE i.id=$1
        GROUP BY i.id
    `, [invitationId]);
    if (!current.rowCount) throw new Error('Invitation not found');
    const row = current.rows[0];
    const status = statusFor(row);
    if (status === 'revoked' || status === 'expired' || status === 'used') {
        throw new Error('Only active invitations can have their link regenerated');
    }
    const token = newToken();
    await query('UPDATE customer_invitations SET token_hash=$2,updated_at=NOW() WHERE id=$1', [invitationId, hashToken(token)]);
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id)
        VALUES($1,'invitation.rotate','invitation',$2)
    `, [actorUserId || null, invitationId]);
    return { token };
}

async function redeemInvitation({ token, email, username, password }) {
    username = cleanUsername(username);
    validatePassword(password);
    const passwordHash = await bcrypt.hash(password, 12);
    const tokenHash = hashToken(token);

    const created = await transaction(async client => {
        const invitationResult = await client.query(`
            SELECT i.*,p.name AS plan_name,p.code AS plan_code,p.billing_interval,p.duration_days,
                   p.active AS plan_active,p.server_class
            FROM customer_invitations i
            JOIN plans p ON p.id=i.plan_id
            WHERE i.token_hash=$1
            FOR UPDATE OF i
        `, [tokenHash]);
        if (!invitationResult.rowCount) throw new Error('This invitation link is invalid');
        const invitation = invitationResult.rows[0];
        const usage = await client.query('SELECT COUNT(*)::int AS use_count FROM invitation_redemptions WHERE invitation_id=$1', [invitation.id]);
        invitation.use_count = usage.rows[0].use_count;
        const status = statusFor(invitation);
        if (status === 'revoked') throw new Error('This invitation has been revoked');
        if (status === 'expired') throw new Error('This invitation has expired');
        if (status === 'used') throw new Error('This invitation has already been used');
        if (!invitation.plan_active) throw new Error('The plan attached to this invitation is no longer active');

        const invitedEmail = cleanEmail(invitation.invited_email, { required: false });
        const accountEmail = invitedEmail || cleanEmail(email);
        if (invitedEmail && email && cleanEmail(email) !== invitedEmail) {
            throw new Error('This invitation is assigned to a different email address');
        }

        const exists = await client.query(`
            SELECT 1 FROM app_users
            WHERE lower(email)=lower($1) OR lower(username)=lower($2)
            LIMIT 1
        `, [accountEmail, username]);
        if (exists.rowCount) throw new Error('An account already exists with that email or username');

        const userResult = await client.query(`
            INSERT INTO app_users(email,username,password_hash,role,email_verified_at)
            VALUES($1,$2,$3,'customer',NOW())
            RETURNING id,email,username,role,active,email_verified_at,created_at
        `, [accountEmail, username, passwordHash]);
        const user = userResult.rows[0];

        const customerResult = await client.query(`
            INSERT INTO customers(user_id,display_name,email)
            VALUES($1,$2,$3)
            RETURNING *
        `, [user.id, username, accountEmail]);
        const customer = customerResult.rows[0];

        const startsAt = new Date();
        const durationDays = Math.max(1, Number(invitation.duration_days || 30));
        const endsAt = new Date(startsAt.getTime() + durationDays * 86400000);
        const subscriptionResult = await client.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,$3,'invitation',$4,$5)
            RETURNING *
        `, [customer.id, invitation.plan_id, invitation.billing_interval === 'trial' ? 'trialing' : 'active', startsAt, endsAt]);
        const subscription = subscriptionResult.rows[0];

        await client.query(`
            INSERT INTO invitation_redemptions(invitation_id,customer_id,user_id,redeemed_email)
            VALUES($1,$2,$3,$4)
        `, [invitation.id, customer.id, user.id, accountEmail]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'invitation.redeem','invitation',$2,$3::jsonb)
        `, [user.id, invitation.id, JSON.stringify({
            customerId: customer.id,
            subscriptionId: subscription.id,
            planId: invitation.plan_id,
            email: accountEmail
        })]);

        return { invitation, user, customer, subscription };
    });

    let reconcile = null;
    let provisioningError = null;
    try {
        reconcile = await provisioning.reconcileCustomer(created.customer.id);
        if (reconcile?.account?.id) {
            await provisioning.setJellyfinPassword(created.customer.id, reconcile.account.id, password);
        }
    } catch (error) {
        provisioningError = error.message;
        console.error(`Invitation provisioning pending for customer ${created.customer.id}:`, error.message);
    }

    return { ...created, reconcile, provisioningError };
}

module.exports = {
    hashToken,
    cleanEmail,
    cleanUsername,
    validatePassword,
    statusFor,
    publicInvitation,
    createInvitation,
    listInvitations,
    lookupInvitation,
    revokeInvitation,
    rotateInvitation,
    redeemInvitation
};
