'use strict';

const discordRoles = require('../integrations/discord-roles');
const { esc } = require('./admin-html');

function reasonText(reason) {
  return ({
    bot_not_configured: 'Configure and enable the Discord bot first.',
    guild_not_configured: 'Add the Discord server (guild) ID in Notification settings.',
    discord_unavailable: 'CAPTAiNFiN could not read roles from Discord right now.',
    missing_manage_roles: 'The Discord bot is connected, but it does not have Manage Roles.',
    bot_role_hierarchy: 'Move the CAPTAiNFiN bot role above the customer roles you want it to manage.',
    no_assignable_roles: 'No assignable server roles are currently below the CAPTAiNFiN bot role.'
  })[reason] || 'Discord role assignment is not ready.';
}

function control(plan, catalogue = {}) {
  const current = discordRoles.snowflake(plan?.discord_role_id) || '';
  const allRoles = Array.isArray(catalogue.roles) ? catalogue.roles : [];
  const assignable = Array.isArray(catalogue.assignableRoles) ? catalogue.assignableRoles : [];
  const currentRole = allRoles.find(role => String(role.id) === current) || null;
  const currentAssignable = assignable.some(role => String(role.id) === current);
  if (catalogue.ready) {
    const preserved = current && !currentAssignable
      ? `<option value="${esc(current)}" selected>Current mapping — ${esc(currentRole?.name || current)} · unavailable</option>`
      : '';
    const options = assignable.map(role => `<option value="${esc(role.id)}" ${String(role.id) === current ? 'selected' : ''}>${esc(role.name)}</option>`).join('');
    const warning = current && !currentAssignable
      ? `<div class="notice warn"><strong>Current mapping needs attention.</strong> ${currentRole ? `${esc(currentRole.name)} cannot currently be assigned by the bot (${esc(currentRole.reason || 'role hierarchy')}).` : `Role ${esc(current)} was not returned by this Discord server.`} Saving another role replaces it; leaving it selected preserves the existing mapping.</div>`
      : '';
    return `<div class="formGroup"><label>Discord plan role</label><select class="input" name="discordRoleId"><option value="" ${current ? '' : 'selected'}>No automatic Discord role</option>${preserved}${options}</select><div class="inlineHelp"><span class="pill good">Discord roles ready</span> ${assignable.length} assignable role${assignable.length === 1 ? '' : 's'} from the configured server. CAPTAiNFiN only adds/removes roles mapped to plans.</div>${warning}</div>`;
  }
  const detail = catalogue.error ? ` ${esc(catalogue.error)}` : '';
  return `<div class="formGroup"><label>Discord plan role</label><div class="notice warn"><strong>Role names unavailable.</strong> ${esc(reasonText(catalogue.reason))}${detail}</div><label class="subText" for="discordRoleId">Manual role ID fallback</label><input id="discordRoleId" class="input" name="discordRoleId" maxlength="40" value="${esc(current)}" placeholder="Discord role snowflake ID"><div class="inlineHelp">The existing mapping is preserved while Discord is unavailable. You can also enter a valid role ID manually. <a href="/admin/notifications/preferences#messaging-settings">Open Discord settings</a>.</div></div>`;
}

function parse(value) {
  const raw = String(value || '').trim().slice(0, 40);
  if (!raw) return null;
  const roleId = discordRoles.snowflake(raw);
  if (!roleId) throw new Error('Choose a Discord role or enter a valid Discord role ID.');
  return roleId;
}

module.exports = { control, parse, reasonText };