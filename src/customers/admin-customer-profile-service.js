'use strict';

const { transaction } = require('../db');

function text(value, max) {
  return String(value || '').trim().slice(0, max);
}

function tags(value) {
  return [...new Set(
    String(value || '')
      .split(/[\n,]/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => item.slice(0, 40))
  )].slice(0, 20);
}

function normalizeProfileInput(input = {}) {
  const displayName = text(input.displayName, 100) || null;
  const phone = text(input.phone, 40) || null;
  const country = text(input.countryCode, 2).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('validation');

  const timezone = text(input.timezone, 80) || null;
  const referral = text(input.referralSource, 120) || null;
  const registration = text(input.registrationSource, 40) || null;
  const discordId = text(input.discordUserId, 32) || null;
  if (discordId && !/^\d{5,32}$/.test(discordId)) throw new Error('discord');

  const discordUsername = text(input.discordUsername, 100) || null;
  const note = text(input.note, 2000);
  const nextTags = tags(input.tags);
  const username = input.username !== undefined ? text(input.username, 40) : null;
  const email = input.email !== undefined ? text(input.email, 254).toLowerCase() : null;

  return {
    displayName,
    phone,
    country: country || null,
    timezone,
    referral,
    registration,
    discordId,
    discordUsername,
    note,
    tags: nextTags,
    username,
    email,
    portalFieldsProvided: username !== null || email !== null
  };
}

async function updateProfile(customerId, input, { actorUserId = null } = {}) {
  const profile = normalizeProfileInput(input);

  await transaction(async client => {
    if (profile.portalFieldsProvided) {
      const customer = await client.query(
        'SELECT user_id FROM customers WHERE id=$1 FOR UPDATE',
        [customerId]
      );
      const userId = customer.rows[0]?.user_id;
      if (userId) {
        if (!/^[A-Za-z0-9._-]{3,40}$/.test(profile.username || '') || !(profile.email || '').includes('@')) {
          throw new Error('portal');
        }
        await client.query(`
          UPDATE app_users
          SET username=$2,
              email=$3,
              email_verified_at=CASE
                WHEN lower(COALESCE(email,''))<>lower($3) THEN NULL
                ELSE email_verified_at
              END,
              updated_at=NOW()
          WHERE id=$1
        `, [userId, profile.username, profile.email]);
      }
    }

    await client.query(`
      UPDATE customers
      SET display_name=$2,
          phone=$3,
          country_code=$4,
          timezone=$5,
          referral_source=$6,
          registration_source=$7,
          discord_user_id=$8,
          discord_username=$9,
          tags=$10,
          note=$11,
          updated_at=NOW()
      WHERE id=$1
    `, [
      customerId,
      profile.displayName,
      profile.phone,
      profile.country,
      profile.timezone,
      profile.referral,
      profile.registration,
      profile.discordId,
      profile.discordUsername,
      profile.tags,
      profile.note
    ]);

    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.profile.update','customer',$2,$3::jsonb)
    `, [
      actorUserId,
      customerId,
      JSON.stringify({
        fields: [
          'display_name',
          'phone',
          'country_code',
          'timezone',
          'referral_source',
          'registration_source',
          'discord',
          'tags',
          'note',
          ...(profile.portalFieldsProvided ? ['portal_username', 'portal_email'] : [])
        ]
      })
    ]);
  });

  return profile;
}

module.exports = {
  text,
  tags,
  normalizeProfileInput,
  updateProfile
};
