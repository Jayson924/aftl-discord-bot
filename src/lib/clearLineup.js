const { ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { getLineupMentions, formatMentionList } = require('./lineupMentions');
const { formatShortTime } = require('./createRaidThread');
const { getCompletionColumn, usesTickets } = require('./raidTypes');
const { buildLootEmbed, getRosterDisplay, getLootRows, updateLootMessage } = require('./lootThread');

const COMPLETED_TAG_NAME = process.env.RAID_COMPLETED_TAG_NAME || 'Cleared';
// Exact tag ID for the Cleared tag (immune to renames/emoji). Hardcoded for
// now; RAID_COMPLETED_TAG_ID env var overrides if set.
const COMPLETED_TAG_ID = process.env.RAID_COMPLETED_TAG_ID || '1496973452417175612';

function getCompletedTag(forumChannel) {
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) return null;
  const tags = forumChannel.availableTags || [];
  if (COMPLETED_TAG_ID) {
    const byId = tags.find(t => t.id === COMPLETED_TAG_ID);
    if (byId) return byId;
  }
  return tags.find(t => t.name.toLowerCase() === COMPLETED_TAG_NAME.toLowerCase()) || null;
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

/**
 * Reuse the loot thread this lineup is already linked to, if it still exists.
 *
 * Un-clearing and re-clearing a lineup runs the clear flow again — but the loot
 * rows are keyed on the lineup, so a second thread would orphan the first and
 * strand its payout message (payout_message_id would point at a message in a
 * thread the bot no longer uses, and the "react ✅" post could never appear).
 * Returns the existing thread (unarchived, embed refreshed) or null to make a
 * new one.
 */
async function reuseLootThread(lineup, raidThread) {
  const { data } = await supabase
    .from('lineups')
    .select('loot_thread_id')
    .eq('id', lineup.id)
    .maybeSingle();

  const threadId = data?.loot_thread_id;
  if (!threadId) return null;

  const thread = await raidThread.client.channels.fetch(threadId).catch(() => null);
  if (!thread) return null; // deleted — fall through and create a fresh one

  if (thread.archived) {
    await thread.setArchived(false, `Re-cleared ${lineup.name} — reopening its loot thread`).catch(err =>
      console.error('[clearLineup] failed to unarchive loot thread:', err.message));
  }
  await updateLootMessage(raidThread.client, lineup.id).catch(err =>
    console.error('[clearLineup] failed to refresh loot embed:', err.message));

  console.log(`[clearLineup] reusing existing loot thread ${threadId} for ${lineup.name}`);
  return thread;
}

async function createLootThread(lineup, raidThread) {
  const lootChannelId = process.env.LOOT_CHANNEL_ID;
  if (!lootChannelId) return null;

  const existing = await reuseLootThread(lineup, raidThread).catch(err => {
    console.error('[clearLineup] loot thread reuse check failed:', err.message);
    return null;
  });
  if (existing) return existing;

  const lootChannel = await raidThread.client.channels.fetch(lootChannelId).catch(() => null);
  if (!lootChannel) return null;

  // The thread's original message is the combined roster + loot embed, which the
  // bot edits in place as loot is logged (see lootThread.js). Normally empty at
  // this point, but a lineup that already had loot (re-cleared after its thread
  // was deleted) keeps it.
  const [rosterDisplay, lootRows] = await Promise.all([
    getRosterDisplay(lineup.id, lineup.raid_type),
    getLootRows(lineup.id),
  ]);
  const embed = buildLootEmbed(lineup, lootRows, rosterDisplay, { raidThreadId: raidThread.id });

  // Match the raid thread naming so paired raid + loot threads are easy to spot:
  //   "<raid_type> <name>"  optionally suffixed with " - <shortTime>"
  const shortTime = lineup.raid_time ? formatShortTime(lineup.raid_time) : null;
  let threadName = `${lineup.raid_type} ${lineup.name}`;
  if (shortTime) threadName += ` - ${shortTime}`;
  if (threadName.length > 100) threadName = threadName.slice(0, 100);

  const isForum = lootChannel.type === ChannelType.GuildForum;
  let lootThread;
  let starter;
  if (isForum) {
    lootThread = await lootChannel.threads.create({
      name: threadName,
      message: { embeds: [embed] },
      reason: `Loot thread for ${lineup.name}`,
    });
    starter = await lootThread.fetchStarterMessage().catch(() => null);
  } else {
    lootThread = await lootChannel.threads.create({
      name: threadName,
      type: ChannelType.PublicThread,
      reason: `Loot thread for ${lineup.name}`,
    });
    starter = await lootThread.send({ embeds: [embed] });
  }

  const mentionGroups = await getLineupMentions(lineup.id, { includePilots: true });
  if (mentionGroups.length > 0) {
    await lootThread.send(formatMentionList(mentionGroups));
  }

  // Link the thread + its original message so `/loot` and the realtime sync can
  // edit it in place. (For forum posts the starter message id === the thread id.)
  // Payout bookkeeping is reset: any previous payout message lived in a thread
  // that's gone, so this one starts fresh (recorded shares in lineup_payouts are
  // kept — the new message renders them as already confirmed).
  try {
    await supabase
      .from('lineups')
      .update({
        loot_thread_id: lootThread.id,
        loot_message_id: starter?.id || lootThread.id,
        payout_message_id: null,
        loot_close_at: null,
        loot_closed: false,
      })
      .eq('id', lineup.id);
  } catch (err) {
    console.error('[clearLineup] failed to link loot thread:', err.message);
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

  const { tagged, lootThread } = await applyClearedDiscordEffects({ lineup, raidThread, skipTag });

  return { tagged, lootThread, playersUpdated, ticketsUpdated };
}

/**
 * The Discord-side effects of a clear: apply the Completed forum tag and spin up
 * a loot thread. Split out from clearLineup so a clear that originated on the
 * web app (where lineups.completed + player completions are already written)
 * can reuse just the Discord work without the completed guard or DB writes.
 *
 * @param {Object} opts
 * @param {Object} opts.lineup - lineup row with at least { id, name, raid_type }
 * @param {import('discord.js').ThreadChannel} opts.raidThread
 * @param {boolean} [opts.skipTag] - skip applying the Completed tag
 * @returns {Promise<{ tagged: boolean, lootThread: import('discord.js').ThreadChannel | null }>}
 */
async function applyClearedDiscordEffects({ lineup, raidThread, skipTag = false }) {
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

  // Loot can be logged from the RAID thread before a loot thread exists (`/loot`
  // resolves by either thread id). The payout message can't post while there's
  // nowhere to put it, and nothing re-checks until the next loot change — so
  // check now that the thread is here. No-op unless everything's already sold.
  if (lootThread) {
    await require('./lootPayout')
      .refreshPayoutState(raidThread.client, { lineupId: lineup.id }, { canPost: true })
      .catch(err => console.error('[clearLineup] payout check failed:', err.message));
  }

  return { tagged, lootThread };
}

module.exports = {
  clearLineup,
  applyClearedDiscordEffects,
  applyCompletedTag,
  getCompletedTag,
  createLootThread,
  markPlayersCompletedForLineup,
  COMPLETED_TAG_NAME,
};
