'use strict';

async function upsertMergedSetting(client, {
  key,
  value,
  actorUserId = null,
  replace = false
}) {
  const result = await client.query(
    `INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
     VALUES($1,$2::jsonb,$3,NOW())
     ON CONFLICT(setting_key) DO UPDATE SET
       setting_value=CASE
         WHEN $4::boolean THEN EXCLUDED.setting_value
         WHEN jsonb_typeof(platform_settings.setting_value)='object'
          AND jsonb_typeof(EXCLUDED.setting_value)='object'
           THEN platform_settings.setting_value||EXCLUDED.setting_value
         ELSE EXCLUDED.setting_value
       END,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING setting_key,setting_value,updated_at`,
    [key, JSON.stringify(value), actorUserId, Boolean(replace)]
  );
  return result.rows[0] || null;
}

async function applyImportedSettings(client, settings = {}, {
  allowedKeys = [],
  actorUserId = null,
  replaceKeys = ['storefront_features']
} = {}) {
  const allowed = new Set(allowedKeys);
  const replacements = new Set(replaceKeys);
  let count = 0;

  for (const [key, value] of Object.entries(settings || {})) {
    if (!allowed.has(key)) continue;
    await upsertMergedSetting(client, {
      key,
      value,
      actorUserId,
      replace: replacements.has(key)
    });
    count += 1;
  }

  return count;
}

module.exports = {
  upsertMergedSetting,
  applyImportedSettings
};
