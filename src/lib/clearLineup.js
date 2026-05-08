const { EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { getLineupMentions, formatMentionList } = require('./lineupMentions');
const { formatShortTime } = require('./createRaidThread');
const { getCompletionColumn, getRaidColor, usesTickets } = require('./raidTypes');

const COMPLETED_TAG_NAME = process.env.RAID_COMPLETED_TAG_NAME || 'Cleared';

function getCompletedTag(forumChannel) {
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) return null;
  return (forumChannel.availableTags || []).find(
    t => t.name.toLowerCase() === COMPLETED_TAG_NAME.toLowerCase()
  ) || null;
}

async function applyCompletedTag(thread) {
  const tag = getCompletedTag(thread.parent);
  if (!tag) return false;

  const current = thread.appliedTags || [];
  if (current.includes(tag.id)) return true;

  await thread.setAppliedTags([...current, tag.id]);
  return true;
}

/**
 * Mark each player in the lineup as having completed this week's raid.
 * Mirrors data.js#markPlayersCompleted on the web app.
 *
 * Sets the per-raid_type completion column on every player in the lineup.
 * Tickets only apply to GDN Classic — sets `classic_ticket_used = now()`
 * for any lineup_player with `uses_ticket = true`.
 *
 * Raid types with no completion column (4-man, Unspecified) are skipped.
 */
async function markPlayersCompletedForLineup(lineup) {
  const column = getCompletionColumn(lineup.raid_type);
  if (!column) {
    return { updated: 0, ticketUpdated: 0 };
  }

  const { data: lineupPlayers, error: lpError } = await supabase
    .from('lineup_players')
    .select('player_name, player_id, uses_ticket')
    .eq('lineup_id', lineup.id);

  if (lpError || !lineupPlayers || lineupPlayers.length === 0) {
    return { updated: 0, ticketUpdated: 0 };
  }

  const ids = lineupPlayers.map(lp => lp.player_id).filter(Boolean);
  const namesWithoutId = lineupPlayers
    .filter(lp => !lp.player_id && lp.player_name)
    .map(lp => lp.player_name);

  const now = new Date().toISOString();

  let updated = 0;
  if (ids.length > 0) {
    const { error, count } = await supabase
      .from('players')
      .update({ [column]: now }, { count: 'exact' })
      .in('id', ids);
    if (error) console.error('[clearLineup] failed to mark by id:', error);
    else updated += count || 0;
  }
  if (namesWithoutId.length > 0) {
    const { error, count } = await supabase
      .from('players')
      .update({ [column]: now }, { count: 'exact' })
      .in('name', namesWithoutId);
    if (error) console.error('[clearLineup] failed to mark by name:', error);
    else updated += count || 0;
  }

  let ticketUpdated = 0;
  if (usesTickets(lineup.raid_type)) {
    const ticketIds = lineupPlayers.filter(lp => lp.uses_ticket && lp.player_id).map(lp => lp.player_id);
    const ticketNames = lineupPlayers
      .filter(lp => lp.uses_ticket && !lp.player_id && lp.player_name)
      .map(lp => lp.player_name);

    if (ticketIds.length > 0) {
      const { error, count } = await supabase
        .from('players')
        .update({ classic_ticket_used: now }, { count: 'exact' })
        .in('id', ticketIds);
      if (error) console.error('[clearLineup] failed to mark tickets by id:', error);
      else ticketUpdated += count || 0;
    }
    if (ticketNames.length > 0) {
      const { error, count } = await supabase
        .from('players')
        .update({ classic_ticket_used: now }, { count: 'exact' })
        .in('name', ticketNames);
      if (error) console.error('[clearLineup] failed to mark tickets by name:', error);
      else ticketUpdated += count || 0;
    }
  }

  return { updated, ticketUpdated };
}

async function createLootThread(lineup, raidThread) {
  const lootChannelId = process.env.LOOT_CHANNEL_ID;
  if (!lootChannelId) return null;

  const lootChannel = await raidThread.client.channels.fetch(lootChannelId).catch(() => null);
  if (!lootChannel) return null;

  const { data: lineupPlayers } = await supabase
    .from('lineup_players')
    .select('player_name, slot_position, uses_ticket, pilot_name')
    .eq('lineup_id', lineup.id)
    .order('slot_position');

  const names = (lineupPlayers || []).map(lp => lp.player_name).filter(Boolean);
  const discordMap = {};
  if (names.length > 0) {
    const { data: players } = await supabase
      .from('players')
      .select('name, discord_id')
      .in('name', names);
    for (const p of players || []) {
      if (p.discord_id) discordMap[p.name] = p.discord_id;
    }
  }

  const roster = (lineupPlayers || [])
    .map((lp, i) => {
      const id = discordMap[lp.player_name];
      const display = id ? `**${lp.player_name}** — <@${id}>` : `**${lp.player_name}**`;
      return `\`${i + 1}.\` ${display}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${lineup.name} — Loot`)
    .setDescription(roster || '_no players_')
    .addFields({ name: 'Raid thread', value: `<#${raidThread.id}>`, inline: true })
    .setColor(getRaidColor(lineup.raid_type));

  // Match the raid thread naming so paired raid + loot threads are easy to spot:
  //   "<raid_type> <name>"  optionally suffixed with " - <shortTime>"
  const shortTime = lineup.raid_time ? formatShortTime(lineup.raid_time) : null;
  let threadName = `${lineup.raid_type} ${lineup.name}`;
  if (shortTime) threadName += ` - ${shortTime}`;
  if (threadName.length > 100) threadName = threadName.slice(0, 100);

  const isForum = lootChannel.type === ChannelType.GuildForum;
  let lootThread;
  if (isForum) {
    lootThread = await lootChannel.threads.create({
      name: threadName,
      message: { embeds: [embed] },
      reason: `Loot thread for ${lineup.name}`,
    });
  } else {
    lootThread = await lootChannel.threads.create({
      name: threadName,
      type: ChannelType.PublicThread,
      reason: `Loot thread for ${lineup.name}`,
    });
    await lootThread.send({ embeds: [embed] });
  }

  const mentionGroups = await getLineupMentions(lineup.id);
  if (mentionGroups.length > 0) {
    await lootThread.send(formatMentionList(mentionGroups));
  }

  return lootThread;
}

/**
 * Run the full "raid cleared" flow: mark the lineup completed, apply the
 * Completed forum tag, and spin up a loot thread.
 *
 * Idempotent: if `lineup.completed` is already true, returns early with
 * `{ alreadyCompleted: true }` and skips tag/loot work.
 *
 * @param {Object} opts
 * @param {Object} opts.lineup - lineup row with at least { id, name, raid_type, completed }
 * @param {import('discord.js').ThreadChannel} opts.raidThread
 * @param {boolean} [opts.skipTag] - skip applying the Completed tag (e.g. when the user just applied it)
 * @returns {Promise<{
 *   alreadyCompleted?: boolean,
 *   tagged: boolean,
 *   lootThread: import('discord.js').ThreadChannel | null,
 *   updateError?: any,
 * }>}
 */
async function clearLineup({ lineup, raidThread, skipTag = false }) {
  if (lineup.completed) return { alreadyCompleted: true, tagged: false, lootThread: null };

  const { error: updateError } = await supabase
    .from('lineups')
    .update({ completed: true })
    .eq('id', lineup.id);

  if (updateError) return { tagged: false, lootThread: null, updateError };

  let playersUpdated = 0;
  let ticketsUpdated = 0;
  try {
    const r = await markPlayersCompletedForLineup(lineup);
    playersUpdated = r.updated;
    ticketsUpdated = r.ticketUpdated;
  } catch (err) {
    console.error('[clearLineup] failed to mark player weekly completions:', err);
  }

  let tagged = false;
  if (!skipTag) {
    tagged = await applyCompletedTag(raidThread).catch(err => {
      console.error('[clearLineup] failed to apply Completed tag:', err);
      return false;
    });
  }

  let lootThread = null;
  try {
    lootThread = await createLootThread(lineup, raidThread);
  } catch (err) {
    console.error('[clearLineup] failed to create loot thread:', err);
  }

  return { tagged, lootThread, playersUpdated, ticketsUpdated };
}

module.exports = {
  clearLineup,
  applyCompletedTag,
  getCompletedTag,
  createLootThread,
  markPlayersCompletedForLineup,
  COMPLETED_TAG_NAME,
};
