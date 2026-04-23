const supabase = require('../supabase');
const { createRaidThread } = require('./createRaidThread');
const { updateRaidThread } = require('./updateRaidThread');

// Default channel to create raid threads in when a request doesn't specify one.
// Override with RAID_THREAD_CHANNEL_ID env var.
const DEFAULT_RAID_CHANNEL_ID = process.env.RAID_THREAD_CHANNEL_ID || '1496954808324587680';

/**
 * Process a single thread_requests row: dispatch by action, create or update,
 * then mark the row done/error.
 * @param {import('discord.js').Client} client
 * @param {Object} request - thread_requests row
 */
async function processThreadRequest(client, request) {
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
  }
}

/**
 * Start listening for new thread_requests rows and process any that are already pending.
 * @param {import('discord.js').Client} client
 */
function startThreadRequestHandler(client) {
  console.log('[ThreadRequests] Starting handler, default channel:', DEFAULT_RAID_CHANNEL_ID);

  // Catch up on any pending requests that may have been created while the bot was offline
  supabase
    .from('thread_requests')
    .select('*')
    .eq('status', 'pending')
    .then(({ data, error }) => {
      if (error) {
        console.error('[ThreadRequests] Failed to fetch pending requests:', error);
        return;
      }
      if (data && data.length > 0) {
        console.log(`[ThreadRequests] Found ${data.length} pending request(s) to catch up on`);
        for (const row of data) {
          processThreadRequest(client, row);
        }
      }
    });

  // Subscribe to new inserts via Realtime
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
