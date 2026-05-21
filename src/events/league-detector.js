const { Events } = require('discord.js');

const LEAGUE_ACTIVITY_NAME = 'League of Legends';

// Possible roast timings (in minutes). 0 = roast immediately on launch.
const ROAST_DELAY_MINUTES = [0, 5, 10, 15];

// Track pending roast timers so we can cancel if they stop playing
const pendingRoasts = new Map();

// Roasts that fire the moment they launch League
const LAUNCH_ROASTS = [
  "{user} just launched League. The five stages of grief begins now.",
  "Caught {user} red-handed opening League. We see you.",
  "{user} fired up League. Is your mom proud of this decision?",
  "{user} booted up League like it was gonna fill the void 💀",
  "Bro really said \"I have nothing better to do\" and launched League 💀",
  "{user} opened League. There's still time to close it. Please.",
  "Alert: {user} just clicked the League icon. Intervention needed.",
  "{user} probably lost money to Berlin and launched League.",
  "Looks like {user} failed a GDN run and launched League",
];

// must include {minutes}
const TIMED_ROASTS = [
  "{minutes} minutes in League... that's {minutes} minutes of {user}'s life they're never getting back.",
  "Someone check on {user}, they've been on League for {minutes} minutes. That's a cry for help.",
  "{minutes} minutes of League and {user}'s LP is probably still the same.",
  "{user} is {minutes} minutes into League. The tilt arc begins.",
  "Just got word that {user} has been playing League for {minutes} minutes. Thoughts and prayers 🙏",
  "{minutes} minutes deep into League. {user}, blink twice if you need help.",
  "Update: {user} is {minutes} minutes into a League session. The jungler is already AFK.",
  "{user}: {minutes} minutes in. How's the team comp treating you?",
  "{minutes} minutes in League and {user}'s blood pressure is climbing.",
  "{user}'s character will probably be stronger if you spent {minutes} minutes in Dragon Nest instead of League."
];

// Roasts that work regardless of timing
const GENERIC_ROASTS = [
  "Imagine being {user} and choosing League of Legends out of all the games available to play.",
  "{user} still playing League in {year}? Gross.",
  "League of Legends? More like League of No Bitches. {user}",
  "POV: {user} chose violence (against their own mental health) by playing League.",
  "Touch grass? Nah, {user} chose to touch Summoner's Rift instead.",
  "{user} chose League. Of all the games. Of all the ways to spend an evening.",
  "Reminder that {user} willingly plays League of Legends.",
  "{user} on League again. We're not even surprised anymore.",
  "{user} could be doing literally anything else right now. They picked League.",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomRoast(member, delayMinutes) {
  const pool =
    delayMinutes === 0
      ? [...LAUNCH_ROASTS, ...GENERIC_ROASTS]
      : [...TIMED_ROASTS, ...GENERIC_ROASTS];

  return pickRandom(pool)
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{year\}/g, new Date().getFullYear().toString())
    .replace(/\{minutes\}/g, String(delayMinutes));
}

const ROAST_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const lastRoastAt = new Map();

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

    // Started playing — schedule a roast at a random delay
    if (isPlaying && !wasPlaying) {
      const lastAt = lastRoastAt.get(memberId);
      if (lastAt && Date.now() - lastAt < ROAST_COOLDOWN_MS) return;

      const member = newPresence.member;
      const guild = newPresence.guild;
      const delayMinutes = pickRandom(ROAST_DELAY_MINUTES);

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
            await channel.send(getRandomRoast(member, delayMinutes));
            lastRoastAt.set(memberId, Date.now());
          }
        } catch (err) {
          console.error('Failed to send League roast:', err);
        }
      }, delayMinutes * 60 * 1000);

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
