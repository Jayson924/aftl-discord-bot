const { Events } = require('discord.js');
const { fetchMember, isExempt, banSpammer } = require('../lib/spamBan');

const WINDOW_MS = 60_000;
const CHANNEL_THRESHOLD = 2;
const MIN_TEXT_LENGTH = 20;
const LINK_PATTERN = /https?:\/\/|discord\.gg\/|discord(app)?\.com\/invite\//i;

// userId -> [{ fingerprint, channelId, at }]
const recentPosts = new Map();

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [userId, posts] of recentPosts) {
    const fresh = posts.filter((p) => p.at >= cutoff);
    if (fresh.length) recentPosts.set(userId, fresh);
    else recentPosts.delete(userId);
  }
}, WINDOW_MS).unref();

function fingerprint(message) {
  const text = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
  const files = [...message.attachments.values()].map((a) => `${a.name}:${a.size}`).sort().join('|');
  return `${text}#${files}`;
}

// Short chatter like "hi" or "gg" is too common across channels to count.
function isSuspicious(message) {
  return message.attachments.size > 0
    || LINK_PATTERN.test(message.content)
    || message.content.trim().length >= MIN_TEXT_LENGTH;
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;
    if (!isSuspicious(message)) return;

    const now = Date.now();
    const print = fingerprint(message);
    const posts = (recentPosts.get(message.author.id) ?? []).filter((p) => now - p.at < WINDOW_MS);
    posts.push({ fingerprint: print, channelId: message.channel.id, at: now });
    recentPosts.set(message.author.id, posts);

    const channels = new Set(posts.filter((p) => p.fingerprint === print).map((p) => p.channelId));
    if (channels.size < CHANNEL_THRESHOLD) return;

    recentPosts.delete(message.author.id);
    const member = await fetchMember(message);
    if (isExempt(message, member)) return;

    await banSpammer(message, member, `same message in ${channels.size} channels within ${WINDOW_MS / 1000}s`);
  },
};
