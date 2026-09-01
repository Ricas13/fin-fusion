'use strict';

const discordNotification = require('./discord-notification');
const telegramMessage = require('./telegram-message');

function render(input = {}) {
    const discord = discordNotification.render(input);
    const embed = Array.isArray(discord.embeds) ? discord.embeds[0] || {} : {};
    const button = Array.isArray(discord.components)
        ? discord.components.flatMap(row => Array.isArray(row?.components) ? row.components : []).find(component => component?.url && component?.label)
        : null;
    return telegramMessage.card({
        title: embed.title || 'CAPTAiN FiN',
        description: embed.description || '',
        fields: embed.fields || [],
        footer: embed.footer?.text || 'CAPTAiN FiN',
        buttonLabel: button?.label || '',
        buttonUrl: button?.url || ''
    });
}

module.exports = { render };
