const { EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { getLineupMentions, formatMentionList } = require('./lineupMentions');

const COMPLETED_TAG_NAME = process.env.RAID_COMPLETED_TAG_NAME || 'Completed';

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
    .setColor(lineup.raid_type === 'Hardcore' ? 0xe74c3c : 0x3498db);

  const threadName = `${lineup.name} — Loot`.slice(0, 100);

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

  return { tagged, lootThread };
}

module.exports = {
  clearLineup,
  applyCompletedTag,
  getCompletedTag,
  createLootThread,
  COMPLETED_TAG_NAME,
};
