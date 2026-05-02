const { EmbedBuilder } = require('discord.js');
const supabase = require('../supabase');
const { formatMention } = require('./lineupMentions');
const { buildSignupRow } = require('./createRaidThread');

const GUILD_TIMEZONE = 'Asia/Singapore'; // GMT+8 — keep in sync with createRaidThread.js

function formatShortTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GUILD_TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const lookup = {};
  for (const p of parts) lookup[p.type] = p.value;

  const timeStr = lookup.minute === '00'
    ? `${lookup.hour}${(lookup.dayPeriod || '').toLowerCase()}`
    : `${lookup.hour}:${lookup.minute}${(lookup.dayPeriod || '').toLowerCase()}`;
  return `${lookup.month} ${lookup.day} ${timeStr}`;
}

/**
 * Build the roster embed + thread name from current lineup state.
 * Mirrors createRaidThread's output so the two stay in sync.
 */
async function buildLineupView(lineup) {
  const playerNames = (lineup.lineup_players || [])
    .map(lp => lp.player_name)
    .filter(Boolean);

  const discordMap = {};
  if (playerNames.length > 0) {
    const { data: players } = await supabase
      .from('players')
      .select('name, discord_id')
      .in('name', playerNames);
    if (players) {
      for (const p of players) {
        if (p.discord_id) discordMap[p.name] = p.discord_id;
      }
    }
  }

  const lineupSize = lineup.raid_type === '4-man' ? 4 : 8;
  const slots = Array(lineupSize).fill('_empty_');
  (lineup.lineup_players || [])
    .sort((a, b) => a.slot_position - b.slot_position)
    .forEach(lp => {
      const idx = lp.slot_position - 1;
      if (idx >= 0 && idx < lineupSize) {
        const charName = lp.player_name || '_empty_';
        const discordId = discordMap[lp.player_name];
        let display = discordId ? `**${charName}** — <@${discordId}>` : `**${charName}**`;
        if (lp.pilot_name) display += ` (pilot: ${lp.pilot_name})`;
        if (lp.uses_ticket) display += ' 🎟️';
        slots[idx] = display;
      }
    });

  const roster = slots.map((p, i) => `\`${i + 1}.\` ${p}`).join('\n');
  const embedFields = [];

  if (lineup.raid_time) {
    const unix = Math.floor(new Date(lineup.raid_time).getTime() / 1000);
    if (!Number.isNaN(unix)) {
      embedFields.push({
        name: 'Scheduled',
        value: `<t:${unix}:F> (<t:${unix}:R>)`,
        inline: true,
      });
    }
  }

  if (lineup.notes && lineup.notes.trim()) {
    const notes = lineup.notes.trim();
    embedFields.push({
      name: 'Notes',
      value: notes.length > 1024 ? notes.slice(0, 1021) + '...' : notes,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`${lineup.name} — ${lineup.raid_type}`)
    .setDescription(roster)
    .addFields(embedFields)
    .setColor(lineup.raid_type === 'Hardcore' ? 0xe74c3c : 0x3498db);

  const shortTime = lineup.raid_time ? formatShortTime(lineup.raid_time) : null;
  let threadName = `${lineup.raid_type} ${lineup.name}`;
  if (shortTime) threadName += ` - ${shortTime}`;
  if (threadName.length > 100) threadName = threadName.slice(0, 100);

  // Build a per-discord-id mention map for ping diff messages
  const idToChars = new Map();
  (lineup.lineup_players || []).forEach(lp => {
    const discordId = discordMap[lp.player_name];
    if (!discordId) return;
    if (!idToChars.has(discordId)) idToChars.set(discordId, []);
    idToChars.get(discordId).push(lp.player_name);
  });

  return {
    embed,
    threadName,
    rosterCharNames: playerNames,
    discordMap,
    idToChars,
  };
}

/**
 * Extract bolded character names from an embed description.
 * Format produced by buildLineupView is `\`N.\` **CharName** — <@id> ...` per slot.
 */
function extractCharNamesFromEmbed(embed) {
  if (!embed || !embed.description) return [];
  const names = [];
  const re = /\*\*([^*]+)\*\*/g;
  let m;
  while ((m = re.exec(embed.description)) !== null) {
    const name = m[1].trim();
    if (name && name !== '_empty_') names.push(name);
  }
  return names;
}

/**
 * Pull the unix timestamp out of the embed's "Scheduled" field if present.
 * Returns null when no scheduled time is set.
 */
function extractScheduledUnixFromEmbed(embed) {
  if (!embed || !embed.fields) return null;
  const field = embed.fields.find(f => f.name === 'Scheduled');
  if (!field) return null;
  const m = /<t:(\d+):/.exec(field.value || '');
  return m ? Number(m[1]) : null;
}

function extractNotesFromEmbed(embed) {
  if (!embed || !embed.fields) return '';
  const field = embed.fields.find(f => f.name === 'Notes');
  return field ? (field.value || '') : '';
}

/**
 * Try to locate the original roster embed message in a thread.
 * Prefers `lineup.thread_message_id`; falls back to scanning the oldest
 * messages in the thread for one authored by us with an embed.
 */
async function fetchEmbedMessage(thread, lineup, client) {
  if (lineup.thread_message_id) {
    try {
      return await thread.messages.fetch(lineup.thread_message_id);
    } catch (err) {
      console.warn(`[ThreadUpdate] Stored embed message ${lineup.thread_message_id} not found, falling back to scan:`, err.message);
    }
  }

  // Forum posts: the embed is the starter message of the thread.
  if (typeof thread.fetchStarterMessage === 'function') {
    try {
      const starter = await thread.fetchStarterMessage();
      if (starter && starter.embeds && starter.embeds.length > 0) return starter;
    } catch (err) {
      // Non-forum threads or starter unavailable — fall through to message scan.
    }
  }

  const messages = await thread.messages.fetch({ limit: 50 });
  // Collection is newest-first; reverse to look at the oldest first.
  const oldestFirst = [...messages.values()].reverse();
  const found = oldestFirst.find(msg =>
    msg.author?.id === client.user.id && msg.embeds && msg.embeds.length > 0
  );
  return found || null;
}

/**
 * Update an existing Discord thread to reflect the latest lineup state.
 * - Edits the roster embed in place
 * - Renames the thread when name/raid_type/raid_time change
 * - Posts a "Lineup updated" message pinging only newly added players
 * - Posts a quiet "Raid time updated" note when only the scheduled time changed
 * - Stays silent when nothing user-visible has changed
 *
 * @param {Object} opts
 * @param {import('discord.js').Client} opts.client
 * @param {string} opts.lineupId
 */
async function updateRaidThread({ client, lineupId }) {
  if (!lineupId) throw new Error('lineupId is required');

  const { data: lineups, error } = await supabase
    .from('lineups')
    .select(`
      *,
      lineup_players (
        player_name,
        slot_position,
        player_id,
        uses_ticket,
        pilot_name
      )
    `)
    .eq('id', lineupId)
    .limit(1);

  if (error) throw new Error(`Failed to fetch lineup: ${error.message}`);
  if (!lineups || lineups.length === 0) throw new Error(`No lineup found with id "${lineupId}".`);

  const lineup = lineups[0];

  if (!lineup.thread_id) {
    throw new Error(`Lineup "${lineup.name}" has no Discord thread to update.`);
  }

  const thread = await client.channels.fetch(lineup.thread_id);
  if (!thread) {
    throw new Error(`Thread ${lineup.thread_id} not found or bot lacks access.`);
  }

  const embedMessage = await fetchEmbedMessage(thread, lineup, client);
  if (!embedMessage) {
    throw new Error(`Could not locate roster embed message in thread ${thread.id}.`);
  }

  const view = await buildLineupView(lineup);

  // Diff against the current embed so we only chat when something user-visible changed.
  const oldEmbed = embedMessage.embeds[0];
  const oldNames = new Set(extractCharNamesFromEmbed(oldEmbed));
  const newNames = new Set(view.rosterCharNames);

  const addedNames = [...newNames].filter(n => !oldNames.has(n));
  const removedNames = [...oldNames].filter(n => !newNames.has(n));
  const rosterChanged = addedNames.length > 0 || removedNames.length > 0;

  const oldUnix = extractScheduledUnixFromEmbed(oldEmbed);
  const newUnix = lineup.raid_time
    ? Math.floor(new Date(lineup.raid_time).getTime() / 1000)
    : null;
  const timeChanged = oldUnix !== newUnix;

  const oldNotes = extractNotesFromEmbed(oldEmbed).trim();
  const newNotes = (lineup.notes || '').trim();
  const notesChanged = oldNotes !== newNotes;

  // Cache the message id if we discovered it via fallback
  if (!lineup.thread_message_id) {
    await supabase
      .from('lineups')
      .update({ thread_message_id: embedMessage.id })
      .eq('id', lineup.id);
  }

  // Always edit the embed — cheap and idempotent. Re-attach signup buttons so
  // they survive every update (Discord clears components if not provided).
  await embedMessage.edit({ embeds: [view.embed], components: [buildSignupRow(lineup.id)] });

  // Rename the thread if the title would have changed
  if (thread.name !== view.threadName) {
    try {
      await thread.setName(view.threadName);
    } catch (err) {
      console.warn(`[ThreadUpdate] Failed to rename thread ${thread.id}:`, err.message);
    }
  }

  // Post a ping-message only for genuine roster changes
  if (rosterChanged) {
    const lines = ['🔄 **Lineup updated**'];

    if (addedNames.length > 0) {
      // Ping owners of newly added characters with their char names
      const addedByDiscordId = new Map();
      for (const name of addedNames) {
        const did = view.discordMap[name];
        if (!did) continue;
        if (!addedByDiscordId.has(did)) addedByDiscordId.set(did, []);
        addedByDiscordId.get(did).push(name);
      }
      const mentions = [...addedByDiscordId.entries()]
        .map(([discordId, characterNames]) => formatMention({ discordId, characterNames }))
        .join('\n');
      const addedNoOwner = addedNames.filter(n => !view.discordMap[n]);
      lines.push(`**Added:**`);
      if (mentions) lines.push(mentions);
      if (addedNoOwner.length > 0) lines.push(addedNoOwner.map(n => `• ${n}`).join('\n'));
    }

    if (removedNames.length > 0) {
      lines.push(`**Removed:** ${removedNames.join(', ')}`);
    }

    await thread.send(lines.join('\n'));
  } else if (timeChanged && newUnix) {
    // Quiet rescheduling note — no pings (DB trigger re-arms the T-30/T-10 reminders)
    await thread.send(`⏰ **Raid time updated** — <t:${newUnix}:F> (<t:${newUnix}:R>)`);
  } else if (timeChanged && !newUnix) {
    await thread.send(`⏰ **Raid time cleared.**`);
  }
  // notesChanged-only: silent — the embed already shows the new notes.
  void notesChanged;

  return { thread, lineup, addedNames, removedNames, timeChanged };
}

module.exports = { updateRaidThread };
