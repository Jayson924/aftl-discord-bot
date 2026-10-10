const { Events, PermissionFlagsBits } = require('discord.js');

// Bans anyone who posts in HONEYPOT_CHANNEL_ID and wipes their last 24h of messages.
const DELETE_MESSAGE_SECONDS = 24 * 60 * 60;

async function logBan(client, line) {
  console.log(line);
  const logChannelId = process.env.ADMIN_AGENT_LOG_CHANNEL_ID;
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    await ch?.send({ content: line.slice(0, 1900), allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[honeypot] log send failed:', err.message);
  }
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    const honeypotId = process.env.HONEYPOT_CHANNEL_ID;
    if (!honeypotId || message.channel.id !== honeypotId) return;
    if (!message.inGuild() || message.author.bot || message.webhookId) return;

    // Never ban the owner or admins (e.g. someone testing the channel).
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (message.author.id === process.env.OWNER_ID
      || message.author.id === message.guild.ownerId
      || member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return;
    }

    const tag = `${message.author.tag} (${message.author.id})`;
    if (member && !member.bannable) {
      await message.delete().catch(() => {});
      await logBan(message.client, `[honeypot] could not ban ${tag}: role is above the bot's. Message deleted.`);
      return;
    }

    try {
      await message.guild.members.ban(message.author.id, {
        deleteMessageSeconds: DELETE_MESSAGE_SECONDS,
        reason: 'Posted in honeypot channel',
      });
      await logBan(message.client, `[honeypot] banned ${tag} for posting in <#${honeypotId}>.`);
    } catch (err) {
      await message.delete().catch(() => {});
      await logBan(message.client, `[honeypot] ban failed for ${tag}: ${err.message}`);
    }
  },
};
