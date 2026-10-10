// Owner-only admin agent: @mention the bot (or DM it) with a request in plain
// language. Anyone else is ignored. See lib/adminAgent.js for the tools.

const { Events, ChannelType } = require('discord.js');
const { runAdminAgent, resetConversation } = require('../lib/adminAgent');
const { checkAndConsume } = require('../lib/rateLimiter');

const RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 };
const TYPING_INTERVAL_MS = 8_000;

function chunk(text, size = 1900) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer breaking on a newline so code blocks and lists stay readable.
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot) return;
    const client = message.client;
    const isDM = message.channel.type === ChannelType.DM;
    if (!isDM && !message.mentions.users.has(client.user.id)) return;

    if (message.author.id !== process.env.OWNER_ID) {
      console.log(`[admin-agent] ignored mention from ${message.author.tag} (${message.author.id})`);
      return;
    }

    // Party screenshots in the loot channel belong to loot-screenshot.js.
    if (message.channel.id === process.env.LOOT_CHANNEL_ID &&
        message.attachments.some((a) => a.contentType?.startsWith('image/'))) return;

    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!text) return;

    if (/^(reset|new chat|forget)$/i.test(text)) {
      resetConversation(message.channel.id);
      await message.reply('Started a fresh conversation.');
      return;
    }

    const rate = checkAndConsume(`admin-agent:${message.author.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      await message.reply(`Slow down a little; try again in ${Math.ceil(rate.retryAfterMs / 60_000)} min.`);
      return;
    }

    await message.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), TYPING_INTERVAL_MS);
    try {
      const reply = await runAdminAgent({ message, text });
      const [first, ...rest] = chunk(reply);
      await message.reply({ content: first, allowedMentions: { repliedUser: false, parse: [] } });
      for (const part of rest) {
        await message.channel.send({ content: part, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      console.error('[admin-agent] run failed:', err);
      await message.reply(`Something went wrong: ${err.message}`.slice(0, 1900)).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  },
};
