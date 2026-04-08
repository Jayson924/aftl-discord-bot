const { Events } = require('discord.js');

const LEAGUE_ACTIVITY_NAME = 'League of Legends';
const ROAST_DELAY_MS = 15 * 60 * 1000; // 15 minutes

// Track pending roast timers so we can cancel if they stop playing
const pendingRoasts = new Map();

const ROASTS = [
  "Bro really said \"I have nothing better to do\" and launched League 💀",
  "15 minutes in League... that's 15 minutes of your life you're never getting back.",
  "Imagine having hobbies and choosing League of Legends.",
  "Still playing League in {year}? Couldn't be me.",
  "Someone check on {user}, they've been on League for 15 minutes. That's a cry for help.",
  "League of Legends? More like League of No Bitches.",
  "{user} booted up League like it was gonna fill the void 💀",
  "POV: {user} chose violence (against their own mental health) by playing League.",
  "15 minutes of League and their LP is probably still the same.",
  "Touch grass? Nah, {user} chose to touch Summoner's Rift instead.",
  "{user} is 15 minutes into League. The tilt arc begins.",
  "Just got word that {user} has been playing League for 15 minutes. Thoughts and prayers 🙏",
];

function getRandomRoast(member) {
  const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
  return roast
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{year\}/g, new Date().getFullYear().toString());
}

module.exports = {
  name: Events.PresenceUpdate,
  execute(oldPresence, newPresence) {
    if (!newPresence?.activities) return;

    const wasPlaying = oldPresence?.activities?.some(
      (a) => a.name === LEAGUE_ACTIVITY_NAME
    );
    const isPlaying = newPresence.activities.some(
      (a) => a.name === LEAGUE_ACTIVITY_NAME
    );

    const memberId = newPresence.member?.id;
    if (!memberId) return;

    // Started playing — schedule a roast in 15 minutes
    if (isPlaying && !wasPlaying) {
      const member = newPresence.member;
      const guild = newPresence.guild;

      const timer = setTimeout(async () => {
        pendingRoasts.delete(memberId);

        // Re-check that they're still playing before roasting
        const freshPresence = guild.presences.cache.get(memberId);
        const stillPlaying = freshPresence?.activities?.some(
          (a) => a.name === LEAGUE_ACTIVITY_NAME
        );
        if (!stillPlaying) return;

        const channelId = process.env.LEAGUE_ROAST_CHANNEL_ID;
        if (!channelId) return;

        try {
          const channel = await guild.channels.fetch(channelId);
          if (channel?.isTextBased()) {
            await channel.send(getRandomRoast(member));
          }
        } catch (err) {
          console.error('Failed to send League roast:', err);
        }
      }, ROAST_DELAY_MS);

      pendingRoasts.set(memberId, timer);
    }

    // Stopped playing — cancel the pending roast
    if (!isPlaying && wasPlaying) {
      const timer = pendingRoasts.get(memberId);
      if (timer) {
        clearTimeout(timer);
        pendingRoasts.delete(memberId);
      }
    }
  },
};
