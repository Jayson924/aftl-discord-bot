const { PermissionFlagsBits } = require('discord.js');

const DELETE_MESSAGE_SECONDS = 24 * 60 * 60;

async function logLine(client, line) {
  console.log(line);
  const logChannelId = process.env.ADMIN_AGENT_LOG_CHANNEL_ID;
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    await ch?.send({ content: line.slice(0, 1900), allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[spam-ban] log send failed:', err.message);
  }
}

async function fetchMember(message) {
  return message.member ?? message.guild.members.fetch(message.author.id).catch(() => null);
}

// Comma-separated role IDs whose holders are never auto-banned.
function exemptRoleIds() {
  return (process.env.SPAM_BAN_EXEMPT_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
}

function isExempt(message, member) {
  return message.author.id === process.env.OWNER_ID
    || message.author.id === message.guild.ownerId
    || Boolean(member?.permissions.has(PermissionFlagsBits.Administrator))
    || exemptRoleIds().some((id) => member?.roles.cache.has(id));
}

// Bans the author and wipes their last 24h of messages; falls back to deleting the message.
async function banSpammer(message, member, reason) {
  const tag = `${message.author.tag} (${message.author.id})`;
  const client = message.client;
  if (member && !member.bannable) {
    await message.delete().catch(() => {});
    await logLine(client, `[spam-ban] could not ban ${tag} (${reason}): role is above the bot's. Message deleted.`);
    return;
  }
  try {
    await message.guild.members.ban(message.author.id, { deleteMessageSeconds: DELETE_MESSAGE_SECONDS, reason });
    await logLine(client, `[spam-ban] banned ${tag}: ${reason}.`);
  } catch (err) {
    await message.delete().catch(() => {});
    await logLine(client, `[spam-ban] ban failed for ${tag} (${reason}): ${err.message}`);
  }
}

module.exports = { fetchMember, isExempt, banSpammer };
