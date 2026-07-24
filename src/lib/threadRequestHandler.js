const supabase = require('../supabase');
const { createRaidThread } = require('./createRaidThread');
const { updateRaidThread } = require('./updateRaidThread');
const { applyClearedDiscordEffects } = require('./clearLineup');
const { updateLootMessage } = require('./lootThread');
const { refreshPayoutState } = require('./lootPayout');

// Default channel to create raid threads in when a request doesn't specify one.
// Override with RAID_THREAD_CHANNEL_ID env var.
const DEFAULT_RAID_CHANNEL_ID = process.env.RAID_THREAD_CHANNEL_ID || '1496954808324587680';

// How often the polling fallback sweeps for pending requests (ms).
// Polling makes processing resilient to the Realtime socket silently dropping.
const POLL_INTERVAL_MS = 15 * 1000;

// IDs currently being processed. Guards against the Realtime handler, the
// startup sweep, and the poll all picking up the same row (which would create
// duplicate threads). Single-process bot, so an in-memory set is sufficient.
const inFlight = new Set();

/**
 * Process a single thread_requests row: dispatch by action, create or update,
 * then mark the row done/error.
 * @param {import('discord.js').Client} client
 * @param {Object} request - thread_requests row
 */
async function processThreadRequest(client, request) {
  // Skip if another trigger (Realtime / poll) is already handling this row.
  if (inFlight.has(request.id)) return;
  inFlight.add(request.id);

  const action = request.action || 'create';
  console.log(`[ThreadRequests] Processing request ${request.id} (${action}) for lineup ${request.lineup_id}`);

  try {
    let resultThreadId;

    if (action === 'update') {
      const { thread } = await updateRaidThread({
        client,
        lineupId: request.lineup_id,
      });
      resultThreadId = thread.id;

      // A cleared lineup also has a LOOT thread whose tracker embed shows the
      // roster (+ pilots). Refresh it too so web roster/pilot edits sync there.
      // Both no-op when the lineup has no loot thread / payout message yet.
      await updateLootMessage(client, request.lineup_id).catch(err =>
        console.error('[ThreadRequests] loot embed refresh failed:', err.message));
      await refreshPayoutState(client, { lineupId: request.lineup_id }, { canPost: false }).catch(err =>
        console.error('[ThreadRequests] payout refresh failed:', err.message));
    } else if (action === 'clear') {
      // A clear that originated on the web app: lineups.completed + player
      // completions are already written there. Here we only do the Discord
      // side — apply the Cleared tag and create the loot thread.
      const { data: lineup, error } = await supabase
        .from('lineups')
        .select('id, name, raid_type, raid_time, thread_id')
        .eq('id', request.lineup_id)
        .single();

      if (error || !lineup) {
        throw new Error(`Lineup ${request.lineup_id} not found for clear.`);
      }

      if (!lineup.thread_id) {
        console.log(`[ThreadRequests] clear: lineup ${lineup.id} has no Discord thread — nothing to tag`);
      } else {
        const thread = await client.channels.fetch(lineup.thread_id).catch(() => null);
        if (!thread) {
          throw new Error(`Thread ${lineup.thread_id} not found or bot lacks access.`);
        }
        const result = await applyClearedDiscordEffects({ lineup, raidThread: thread });
        resultThreadId = thread.id;

        const parts = [`**${lineup.name}** marked as cleared from the raid manager.`];
        if (result.lootThread) parts.push(`Loot thread: <#${result.lootThread.id}>`);
        await thread.send(parts.join('\n')).catch(err =>
          console.error('[ThreadRequests] clear confirmation failed:', err));
      }
    } else {
      const channelId = request.channel_id || DEFAULT_RAID_CHANNEL_ID;
      const channel = await client.channels.fetch(channelId);
      if (!channel) {
        throw new Error(`Channel ${channelId} not found or bot lacks access.`);
      }
      const { thread } = await createRaidThread({
        channel,
        lineupId: request.lineup_id,
      });
      resultThreadId = thread.id;
    }

    const { error: updateError } = await supabase
      .from('thread_requests')
      .update({
        status: 'done',
        thread_id: resultThreadId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.id);

    if (updateError) {
      console.error('[ThreadRequests] Failed to mark request done:', updateError);
    } else {
      console.log(`[ThreadRequests] Request ${request.id} done (thread ${resultThreadId})`);
    }
  } catch (err) {
    console.error(`[ThreadRequests] Failed to process request ${request.id}:`, err);

    await supabase
      .from('thread_requests')
      .update({
        status: 'error',
        error: err.message || 'Unknown error',
        updated_at: new Date().toISOString(),
      })
      .eq('id', request.id);
  } finally {
    inFlight.delete(request.id);
  }
}

/**
 * Sweep for pending requests and process them. Runs on startup and on an
 * interval as a fallback for when the Realtime subscription isn't delivering
 * (e.g. the websocket dropped). Rows already in flight are skipped by
 * processThreadRequest's guard.
 * @param {import('discord.js').Client} client
 */
async function pollPendingRequests(client) {
  const { data, error } = await supabase
    .from('thread_requests')
    .select('*')
    .eq('status', 'pending');

  if (error) {
    console.error('[ThreadRequests] Failed to poll pending requests:', error);
    return;
  }
  if (data && data.length > 0) {
    console.log(`[ThreadRequests] Poll found ${data.length} pending request(s)`);
    for (const row of data) {
      processThreadRequest(client, row);
    }
  }
}

/**
 * Start listening for new thread_requests rows and process any that are already pending.
 * @param {import('discord.js').Client} client
 */
function startThreadRequestHandler(client) {
  console.log('[ThreadRequests] Starting handler, default channel:', DEFAULT_RAID_CHANNEL_ID);

  // Polling fallback: sweep pending requests on startup (catches anything queued
  // while the bot was offline) and every POLL_INTERVAL_MS thereafter. This is the
  // safety net that keeps the feature working even if Realtime stops delivering.
  pollPendingRequests(client).catch(err =>
    console.error('[ThreadRequests] Initial poll failed:', err));

  setInterval(() => {
    pollPendingRequests(client).catch(err =>
      console.error('[ThreadRequests] Scheduled poll failed:', err));
  }, POLL_INTERVAL_MS);

  // Subscribe to new inserts via Realtime for low-latency processing when the
  // socket is healthy (the poll above is the fallback if it isn't).
  const channel = supabase
    .channel('thread-requests-handler')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'thread_requests' },
      (payload) => {
        const row = payload.new;
        if (row && row.status === 'pending') {
          processThreadRequest(client, row);
        }
      }
    )
    .subscribe((status) => {
      console.log('[ThreadRequests] Subscription status:', status);
    });

  return channel;
}

module.exports = { startThreadRequestHandler };
