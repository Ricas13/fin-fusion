'use strict';

const crypto = require('crypto');
const { query, transaction } = require('./db');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(length = 8) {
    let code = '';
    for (const byte of crypto.randomBytes(length)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return code;
}

async function ensureReferralCode(customerId) {
    const existing = await query('SELECT code FROM referral_codes WHERE customer_id=$1', [customerId]);
    if (existing.rowCount) return existing.rows[0].code;

    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        try {
            const inserted = await query(
                'INSERT INTO referral_codes(customer_id,code) VALUES($1,$2) RETURNING code',
                [customerId, code]
            );
            return inserted.rows[0].code;
        } catch (error) {
            if (error.code !== '23505') throw error;
            const found = await query('SELECT code FROM referral_codes WHERE customer_id=$1', [customerId]);
            if (found.rowCount) return found.rows[0].code;
        }
    }
    throw new Error('Could not generate a referral code');
}

async function attributeReferral(referredCustomerId, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return null;

    const referral = await query('SELECT id,customer_id FROM referral_codes WHERE code=$1', [code]);
    if (!referral.rowCount) return null;
    if (referral.rows[0].customer_id === referredCustomerId) return null;

    await query(`
        INSERT INTO referral_redemptions(referral_code_id,referred_customer_id,status)
        VALUES($1,$2,'pending')
        ON CONFLICT (referred_customer_id) DO NOTHING
    `, [referral.rows[0].id, referredCustomerId]);
    return referral.rows[0].id;
}

async function loadSettings() {
    const result = await query("SELECT setting_value FROM platform_settings WHERE setting_key='referral_program'");
    const value = result.rows[0]?.setting_value || {};
    const rewardDays = Number.parseInt(value.rewardDays, 10);
    return {
        rewardDays: Number.isFinite(rewardDays) && rewardDays > 0 ? Math.min(rewardDays, 365) : 7,
        enabled: value.enabled !== false
    };
}

async function rewardIfQualifying(referredCustomerId) {
    const settings = await loadSettings();
    if (!settings.enabled) return null;

    return transaction(async client => {
        const pending = await client.query(`
            SELECT rr.id,rr.referral_code_id,rc.customer_id AS referrer_customer_id
            FROM referral_redemptions rr JOIN referral_codes rc ON rc.id=rr.referral_code_id
            WHERE rr.referred_customer_id=$1 AND rr.status='pending'
            LIMIT 1 FOR UPDATE OF rr
        `, [referredCustomerId]);
        if (!pending.rowCount) return null;
        const redemption = pending.rows[0];

        const target = await client.query(`
            SELECT id FROM subscriptions
            WHERE customer_id=$1 AND status IN ('active','trialing')
            ORDER BY current_period_end ASC LIMIT 1 FOR UPDATE
        `, [redemption.referrer_customer_id]);

        if (!target.rowCount) {
            await client.query(`
                UPDATE referral_redemptions SET status='unfulfilled',reward_note=$2 WHERE id=$1
            `, [redemption.id, 'Referrer had no active subscription to extend at reward time']);
            return { rewarded: false };
        }

        await client.query(
            `UPDATE subscriptions SET current_period_end=current_period_end + ($2 || ' days')::interval, updated_at=NOW() WHERE id=$1`,
            [target.rows[0].id, settings.rewardDays]
        );
        await client.query(`
            UPDATE referral_redemptions SET status='rewarded',rewarded_at=NOW(),reward_note=$2 WHERE id=$1
        `, [redemption.id, `Extended referrer subscription by ${settings.rewardDays} day(s)`]);
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('referral.reward','subscription',$1,$2::jsonb)
        `, [target.rows[0].id, JSON.stringify({ referrerCustomerId: redemption.referrer_customer_id, referredCustomerId, rewardDays: settings.rewardDays })]);
        return { rewarded: true, days: settings.rewardDays };
    });
}

module.exports = {
    ensureReferralCode,
    attributeReferral,
    rewardIfQualifying,
    loadSettings
};
