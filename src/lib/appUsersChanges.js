// Shared Supabase Realtime subscription for the `app_users` table.
//
// Same rationale as playersChanges.js: multiple `postgres_changes` bindings on
// the same table — even across separate channels — collide and drop to
// CHANNEL_ERROR, and a poisoned postgres_changes connection can take the other
// realtime channels down with it. The new-user notifier (INSERT) and the
// raid-role scheduler (UPDATE on exclude) both need app_users changes, so they
// share this single hub instead of each opening their own channel.
//
// Register listeners with onAppUsersChange(); start the single subscription with
// startAppUsersChanges() (idempotent — safe to call from multiple features).

const supabase = require('../supabase');

const listeners = [];
let channel = null;

/**
 * Register a callback invoked with each app_users postgres_changes payload.
 * Payload shape matches supabase-js: { eventType, new, old, ... }.
 */
function onAppUsersChange(listener) {
  if (typeof listener === 'function') listeners.push(listener);
}

function startAppUsersChanges() {
  if (channel) return channel; // already subscribed

  channel = supabase
    .channel('app-users-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_users' },
      (payload) => {
        for (const listener of listeners) {
          try {
            listener(payload);
          } catch (err) {
            console.error('[app-users-changes] listener error:', err);
          }
        }
      }
    )
    .subscribe((status) => {
      console.log(`[app-users-changes] channel: ${status}`);
    });

  return channel;
}

module.exports = { onAppUsersChange, startAppUsersChanges };
