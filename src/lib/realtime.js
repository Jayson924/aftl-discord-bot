// Self-healing Supabase Realtime subscriptions.
//
// Why this exists: a bare `supabase.channel(x).on(...).subscribe(cb)` is
// fire-and-forget. If the channel later errors, times out, or the socket drops
// without recovering, the callback reports it ONCE and nothing rejoins — the bot
// keeps running, looks healthy, and silently stops hearing about database
// changes until someone restarts it. That is exactly how the loot tracker and
// the gold-share ✅ sync went dead (2026-08-24): the process was fine, the
// `lineup_loot` / `lineup_payouts` channels were not, and the only path that
// posts a payout message hangs off those channels.
//
// subscribeWithRetry() adds two layers of recovery:
//   1. Status-driven — CHANNEL_ERROR / TIMED_OUT / CLOSED schedule a rejoin with
//      exponential backoff.
//   2. A watchdog — every WATCHDOG_MS we check the channel is actually `joined`.
//      This is the one that matters: a channel can go quiet WITHOUT ever firing
//      an error status, and only a state poll notices.
//
// Handlers that must not miss an event should still have a polling fallback (see
// threadRequestHandler's pollPendingRequests / lootPayout's reconciler) — this
// helper narrows the window, it doesn't make delivery guaranteed.

const supabase = require('../supabase');

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const WATCHDOG_MS = 45_000;
const LEAVE_TIMEOUT_MS = 5_000;

const DEAD_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

// removeChannel() waits for a leave ack that never comes when the socket is
// already down — cap it so a rejoin can't be blocked by the very outage it's
// recovering from.
function removeChannelSafely(channel) {
  if (!channel) return Promise.resolve();
  return Promise.race([
    Promise.resolve(supabase.removeChannel(channel)).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, LEAVE_TIMEOUT_MS)),
  ]);
}

/**
 * Subscribe to postgres_changes on one table, rejoining forever if the channel
 * dies. Returns { stop() } — call it to unsubscribe for good.
 *
 * @param {object}   opts
 * @param {string}   opts.label        log prefix, e.g. 'loot'
 * @param {string}   opts.channelName  realtime topic, e.g. 'lineup-loot-sync'
 * @param {string}   opts.table
 * @param {string}   [opts.event='*']
 * @param {string}   [opts.schema='public']
 * @param {string}   [opts.filter]     postgres_changes filter string
 * @param {Function} opts.handler      called with each payload (throws are caught)
 * @param {Function} [opts.onResubscribe] called after a REJOIN (not the first
 *   join) — the hook for reconciling whatever was missed while the channel was down.
 */
function subscribeWithRetry({
  label,
  channelName,
  table,
  event = '*',
  schema = 'public',
  filter,
  handler,
  onResubscribe,
}) {
  let channel = null;
  let generation = 0;   // invalidates callbacks from channels we've moved past
  let attempt = 0;
  let retryTimer = null;
  let watchdog = null;
  let stopped = false;
  let everJoined = false;

  const scheduleRejoin = (why) => {
    if (stopped || retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    attempt += 1;
    console.warn(`[${label}] ${channelName} ${why} — rejoining in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      join();
    }, delay);
  };

  const join = async () => {
    if (stopped) return;
    // Bump the generation FIRST so the outgoing channel's own CLOSED callback
    // (fired by removeChannel below) can't schedule a competing rejoin.
    const gen = ++generation;
    const previous = channel;
    channel = null;
    await removeChannelSafely(previous);
    if (stopped || gen !== generation) return;

    const config = { event, schema, table };
    if (filter) config.filter = filter;

    channel = supabase
      .channel(channelName)
      .on('postgres_changes', config, (payload) => {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[${label}] handler error:`, err);
        }
      })
      .subscribe((status, err) => {
        if (stopped || gen !== generation) return;
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          const rejoined = everJoined;
          everJoined = true;
          console.log(`[${label}] ${channelName}: SUBSCRIBED${rejoined ? ' (rejoined)' : ''}`);
          // Catch up on anything that changed while we weren't listening.
          if (rejoined && onResubscribe) {
            Promise.resolve()
              .then(onResubscribe)
              .catch(e => console.error(`[${label}] resubscribe hook failed:`, e.message));
          }
          return;
        }
        console.warn(`[${label}] ${channelName}: ${status}${err ? ` — ${err.message}` : ''}`);
        if (DEAD_STATUSES.has(status)) scheduleRejoin(status);
      });
  };

  // The safety net for a channel that stops delivering without ever reporting an
  // error: if it isn't `joined` and we aren't already retrying, force a rejoin.
  watchdog = setInterval(() => {
    if (stopped || retryTimer) return;
    const state = channel?.state;
    if (state === 'joined' || state === 'joining') return;
    scheduleRejoin(`watchdog saw state=${state ?? 'none'}`);
  }, WATCHDOG_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  join().catch(err => console.error(`[${label}] initial join failed:`, err.message));

  return {
    get state() {
      return channel?.state ?? 'none';
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      removeChannelSafely(channel);
    },
  };
}

module.exports = { subscribeWithRetry };
