'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const registry = require('./registry');

function randomPassword() {
    return crypto.randomBytes(24).toString('base64url');
}

function policyForPlan(plan, disabled = false) {
    const enabled = !disabled;
    return {
        IsAdministrator: false,
        IsHidden: true,
        IsDisabled: disabled,
        EnableAllDevices: enabled,
        EnableAllFolders: enabled,
        EnableAllChannels: false,
        EnableRemoteAccess: enabled,
        EnableMediaPlayback: enabled,
        EnableAudioPlaybackTranscoding: enabled && Boolean(plan.allow_audio_transcoding),
        EnableVideoPlaybackTranscoding: enabled && Boolean(plan.allow_video_transcoding),
        EnablePlaybackRemuxing: enabled && Boolean(plan.allow_video_transcoding),
        EnableContentDownloading: enabled && Boolean(plan.allow_downloads),
        EnableSyncTranscoding: false,
        EnableMediaConversion: false,
        EnableContentDeletion: false,
        EnableRemoteControlOfOtherUsers: false,
        EnableSharedDeviceControl: false,
        EnableLiveTvManagement: enabled && Boolean(plan.allow_live_tv_management),
        EnableLiveTvAccess: enabled && Boolean(plan.allow_live_tv),
        EnableUserPreferenceAccess: enabled,
        AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
        PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
        SyncPlayAccess: 'None'
    };
}

async function selectServerForPlan(plan) {
    const isTrial = plan.billing_interval === 'trial';
    const result = await query(`
        SELECT js.*,
               COUNT(ja.id)::int AS assigned_users,
               CASE WHEN js.max_users IS NULL OR js.max_users=0 THEN 0
                    ELSE COUNT(ja.id)::numeric/js.max_users END AS load_ratio
        FROM jellyfin_servers js
        LEFT JOIN jellyfin_accounts ja ON ja.server_id=js.id AND ja.disabled=FALSE
        WHERE js.enabled=TRUE
          AND js.allow_new_users=TRUE
          AND js.server_class=$1
          AND js.health_status <> 'offline'
          AND CASE WHEN $2::boolean THEN js.trial_enabled ELSE js.paid_enabled END
        GROUP BY js.id
        HAVING js.max_users IS NULL OR js.max_users=0 OR COUNT(ja.id) < js.max_users
        ORDER BY
          CASE js.health_status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 WHEN 'degraded' THEN 2 ELSE 3 END,
          load_ratio ASC,
          js.priority ASC,
          js.name ASC
        LIMIT 1
    `, [plan.server_class, isTrial]);
    return result.rows[0] || null;
}

async function currentEntitlement(customerId) {
    const result = await query(`
        SELECT s.*,p.*,
               s.id AS subscription_id,p.id AS plan_id
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        WHERE s.customer_id=$1
          AND s.status IN ('active','trialing','past_due')
          AND s.current_period_end > NOW()
          AND p.active=TRUE
        ORDER BY s.current_period_end DESC,s.created_at DESC
        LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}

async function preferredUsername(customerId) {
    const result = await query(`
        SELECT COALESCE(NULLIF(c.display_name,''),u.username,'user') AS username
        FROM customers c LEFT JOIN app_users u ON u.id=c.user_id
        WHERE c.id=$1
    `, [customerId]);
    if (!result.rowCount) throw new Error('Customer not found');
    return String(result.rows[0].username || 'user').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'user';
}

async function uniqueUsername(serverId, preferred) {
    const users = await registry.request(serverId, '/Users');
    const names = new Set((Array.isArray(users) ? users : []).map(u => String(u.Name || '').toLowerCase()));
    if (!names.has(preferred.toLowerCase())) return preferred;
    for (let i = 0; i < 20; i++) {
        const suffix = crypto.randomInt(1000, 10000);
        const candidate = `${preferred.slice(0, 35)}${suffix}`;
        if (!names.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error('Unable to generate a unique Jellyfin username');
}

async function createJellyfinAccount(customerId, server, plan) {
    const preferred = await preferredUsername(customerId);
    const username = await uniqueUsername(server.id, preferred);
    const bootstrapPassword = randomPassword();
    const created = await registry.request(server.id, '/Users/New', {
        method: 'POST',
        body: { Name: username, Password: bootstrapPassword }
    });
    if (!created || !created.Id) throw new Error('Jellyfin did not return a user ID');

    try {
        await registry.request(server.id, `/Users/${created.Id}/Policy`, {
            method: 'POST',
            body: policyForPlan(plan, false)
        });
    } catch (error) {
        try { await registry.request(server.id, `/Users/${created.Id}`, { method: 'DELETE' }); } catch (_) {}
        throw error;
    }

    const stored = await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_policy_sync)
        VALUES($1,$2,$3,$4,FALSE,NOW())
        RETURNING *
    `, [customerId, server.id, created.Id, username]);
    return stored.rows[0];
}

async function applyPolicy(account, plan, disabled = false) {
    await registry.request(account.server_id, `/Users/${account.jellyfin_user_id}/Policy`, {
        method: 'POST',
        body: policyForPlan(plan, disabled)
    });
    await query(`
        UPDATE jellyfin_accounts
        SET disabled=$1,last_policy_sync=NOW(),updated_at=NOW()
        WHERE id=$2
    `, [disabled, account.id]);
}

async function recordRun(customerId, subscriptionId, action, fn) {
    const started = await query(`
        INSERT INTO provisioning_runs(customer_id,subscription_id,action,status)
        VALUES($1,$2,$3,'started') RETURNING id
    `, [customerId, subscriptionId || null, action]);
    const id = started.rows[0].id;
    try {
        const value = await fn();
        await query(`UPDATE provisioning_runs SET status='succeeded',completed_at=NOW() WHERE id=$1`, [id]);
        return value;
    } catch (error) {
        await query(`
            UPDATE provisioning_runs
            SET status='failed',detail=$2::jsonb,completed_at=NOW()
            WHERE id=$1
        `, [id, JSON.stringify({ error: error.message })]);
        throw error;
    }
}

async function reconcileCustomer(customerId) {
    const entitlement = await currentEntitlement(customerId);
    return recordRun(customerId, entitlement?.subscription_id || null, entitlement ? 'reconcile' : 'disable', async () => {
        const accountsResult = await query(`
            SELECT ja.*,js.enabled AS server_enabled,js.server_class
            FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
            WHERE ja.customer_id=$1 ORDER BY ja.created_at ASC
        `, [customerId]);
        const accounts = accountsResult.rows;

        if (!entitlement) {
            for (const account of accounts) {
                if (!account.disabled && account.server_enabled) {
                    await applyPolicy(account, {
                        allow_audio_transcoding: false,
                        allow_video_transcoding: false,
                        allow_downloads: false,
                        allow_live_tv: false,
                        allow_live_tv_management: false
                    }, true);
                }
            }
            return { active: false, disabled: accounts.length };
        }

        let account = accounts.find(a => a.server_class === entitlement.server_class && a.server_enabled);
        if (!account) {
            const server = await selectServerForPlan(entitlement);
            if (!server) throw new Error(`No eligible ${entitlement.server_class} Jellyfin server has capacity`);
            account = await createJellyfinAccount(customerId, server, entitlement);
        }

        await applyPolicy(account, entitlement, false);
        for (const old of accounts) {
            if (old.id !== account.id && !old.disabled && old.server_enabled) {
                await applyPolicy(old, entitlement, true);
            }
        }

        await query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('entitlement.reconcile','customer',$1,$2::jsonb)
        `, [customerId, JSON.stringify({
            subscriptionId: entitlement.subscription_id,
            planCode: entitlement.code,
            serverId: account.server_id,
            jellyfinAccountId: account.id,
            streamLimit: entitlement.streams
        })]);

        return { active: true, entitlement, account };
    });
}

async function setJellyfinPassword(customerId, accountId, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
        throw new Error('Jellyfin password must be between 8 and 200 characters');
    }
    const result = await query(`
        SELECT * FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2
    `, [accountId, customerId]);
    if (!result.rowCount) throw new Error('Jellyfin account not found');
    const account = result.rows[0];

    return recordRun(customerId, null, 'password_reset', async () => {
        await registry.request(account.server_id, `/Users/${account.jellyfin_user_id}/Password`, {
            method: 'POST',
            body: { Id: account.jellyfin_user_id, NewPw: newPassword }
        });
        return true;
    });
}

async function expireSubscriptionsAndReconcile() {
    const expired = await transaction(async client => {
        const rows = await client.query(`
            UPDATE subscriptions
            SET status='expired',updated_at=NOW()
            WHERE status IN ('active','trialing','past_due') AND current_period_end <= NOW()
            RETURNING DISTINCT customer_id
        `);
        return rows.rows.map(r => r.customer_id);
    });
    for (const customerId of expired) {
        try { await reconcileCustomer(customerId); } catch (error) {
            console.error(`Entitlement reconcile failed for ${customerId}:`, error.message);
        }
    }
    return expired.length;
}

module.exports = {
    policyForPlan,
    selectServerForPlan,
    currentEntitlement,
    reconcileCustomer,
    setJellyfinPassword,
    expireSubscriptionsAndReconcile
};
