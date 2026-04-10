const { EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { getLineupMentions, formatMentionList } = require('./lineupMentions');

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
  const slots = Array(8).fill('_empty_');
  (lineup.lineup_players || [])
    .sort((a, b) => a.slot_position - b.slot_position)
    .forEach(lp => {
      const idx = lp.slot_position - 1;
      if (idx >= 0 && idx < 8) {
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

  const embed = new EmbedBuilder()
    .setTitle(`${lineup.name} — ${lineup.raid_type}`)
    .setDescription(roster)
    .addFields(
      { name: 'Status', value: lineup.completed ? 'Completed' : (lineup.status || 'draft'), inline: true },
    )
    .setColor(lineup.raid_type === 'Hardcore' ? 0xe74c3c : 0x3498db);

  // Create the thread
  const thread = await channel.threads.create({
    name: `${lineup.raid_type} — ${lineup.name}`,
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
