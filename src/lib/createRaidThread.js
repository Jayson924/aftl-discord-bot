const { EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { getLineupMentions, formatMentionList } = require('./lineupMentions');

// Guild timezone — raid times are displayed here in thread titles
const GUILD_TIMEZONE = 'Asia/Singapore'; // GMT+8

/**
 * Format an ISO timestamp as a short human-readable string like "Apr 11 5pm"
 * or "Apr 11 5:30pm" (omits minutes when :00), in the guild's timezone.
 */
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

  const month = lookup.month;
  const day = lookup.day;
  const hour = lookup.hour;
  const minute = lookup.minute;
  const dayPeriod = (lookup.dayPeriod || '').toLowerCase();

  const timeStr = minute === '00' ? `${hour}${dayPeriod}` : `${hour}:${minute}${dayPeriod}`;
  return `${month} ${day} ${timeStr}`;
}

/**
 * Core logic for creating a Discord thread for a raid lineup.
 * Used by both the /raidthread slash command and the thread_requests Realtime handler.
 *
 * @param {Object} opts
 * @param {import('discord.js').TextChannel} opts.channel - The parent channel to create the thread in
 * @param {string} [opts.lineupId] - Lineup UUID (preferred)
 * @param {string} [opts.lineupName] - Lineup name (fallback when id not available)
 * @returns {Promise<{ thread: import('discord.js').ThreadChannel, lineup: Object }>}
 */
async function createRaidThread({ channel, lineupId, lineupName }) {
  if (!channel) throw new Error('channel is required');
  if (!lineupId && !lineupName) throw new Error('lineupId or lineupName is required');

  // Fetch the lineup
  let query = supabase
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
    .limit(1);

  if (lineupId) {
    query = query.eq('id', lineupId);
  } else {
    query = query.ilike('name', lineupName);
  }

  const { data: lineups, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch lineup: ${error.message}`);
  }
  if (!lineups || lineups.length === 0) {
    throw new Error(lineupId
      ? `No lineup found with id "${lineupId}".`
      : `No lineup found with name "${lineupName}".`);
  }

  const lineup = lineups[0];

  // Look up discord IDs by player name (for the per-slot roster display)
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

  // Build roster — show character name first, then mention so people can tell which char is theirs
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

  const roster = slots
    .map((p, i) => `\`${i + 1}.\` ${p}`)
    .join('\n');

  const embedFields = [];

  // If the lineup has a scheduled time, include it as a Discord dynamic timestamp
  // (auto-localized per viewer + relative countdown)
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

  // If the lineup has notes, include them as a non-inline field so they get a full row
  if (lineup.notes && lineup.notes.trim()) {
    const notes = lineup.notes.trim();
    // Discord field values are capped at 1024 chars
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

  // Build thread name — append short time if the lineup has a scheduled raid time
  const shortTime = lineup.raid_time ? formatShortTime(lineup.raid_time) : null;
  let threadName = `${lineup.raid_type} ${lineup.name}`;
  if (shortTime) threadName += ` - ${shortTime}`;
  // Discord thread names are capped at 100 characters
  if (threadName.length > 100) threadName = threadName.slice(0, 100);

  // Create the thread
  const thread = await channel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    reason: `Raid thread for ${lineup.name}`,
  });

  // Post lineup embed in the thread
  await thread.send({ embeds: [embed] });

  // Ping players in the thread — show each mention alongside their character(s)
  const mentionGroups = await getLineupMentions(lineup.id);
  if (mentionGroups.length > 0) {
    await thread.send(formatMentionList(mentionGroups));
  }

  // Persist thread id on the lineup row
  const { error: updateError } = await supabase
    .from('lineups')
    .update({ thread_id: thread.id })
    .eq('id', lineup.id);

  if (updateError) {
    console.error('Failed to persist thread_id on lineup:', updateError);
    // Non-fatal: the thread is already created
  }

  return { thread, lineup };
}

module.exports = { createRaidThread };
