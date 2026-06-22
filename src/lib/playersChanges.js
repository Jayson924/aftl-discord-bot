// Shared Supabase Realtime subscription for the `players` table.
//
// Multiple features need to react to player changes (raid-need roles, the
// new-character review notifier). Each used to open its own `postgres_changes`
// channel on `players`, but two overlapping bindings on the same table (one
// `event: '*'`, one `event: 'INSERT'`) collide and drop to CHANNEL_ERROR — so
// the later subscriber silently stopped receiving events.
//
// This hub subscribes to `players` exactly once (event: '*') and fans every
// change out to all registered listeners. Register listeners with
// onPlayersChange(); start the single subscription with startPlayersChanges()
// (idempotent — safe to call from multiple feature start functions).

const supabase = require('../supabase');

const listeners = [];
let channel = null;

/**
 * Register a callback invoked with each players postgres_changes payload.
 * Payload shape matches supabase-js: { eventType, new, old, ... }.
 */
function onPlayersChange(listener) {
  if (typeof listener === 'function') listeners.push(listener);
}

function startPlayersChanges() {
  if (channel) return channel; // already subscribed

  channel = supabase
    .channel('players-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players' },
      (payload) => {
        for (const listener of listeners) {
          try {
            listener(payload);
          } catch (err) {
            console.error('[players-changes] listener error:', err);
          }
        }
      }
    )
    .subscribe((status) => {
      console.log(`[players-changes] channel: ${status}`);
    });

  return channel;
}

module.exports = { onPlayersChange, startPlayersChanges };
