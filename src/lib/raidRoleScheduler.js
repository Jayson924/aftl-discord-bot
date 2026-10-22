// Triggers for the dynamic raid-need role system:
//   - Supabase Realtime on `players` + `app_users` → react to any change that
//     might shift a user's eligibility (clears via web app or bot, exclude
//     toggles, owner changes, character add/delete).
//   - Weekly Friday 16:05 UTC safety-net full reconcile after the game reset and pg_cron cleanup.

const { onPlayersChange, startPlayersChanges } = require('./playersChanges');
const { onAppUsersChange, startAppUsersChanges } = require('./appUsersChanges');
const { syncUserRaidRoles, syncAllUsers } = require('./raidRoleSync');
const { ALL_COMPLETION_COLUMNS, WEEKLY_CLEARS_COLUMNS } = require('./raidTypes');

const CRON_CHECK_INTERVAL_MS = 60 * 1000;
const DEBOUNCE_MS = 2000;

// Columns whose changes should re-evaluate a user's roles. Anything outside
// this set (e.g. equipment, notes) doesn't move the needle.
const PLAYER_TRIGGER_COLUMNS = new Set([
  ...ALL_COMPLETION_COLUMNS,
  ...WEEKLY_CLEARS_COLUMNS,
  'tickets_used',
  'exclude',
  'discord_id',
]);

function getPrimaryGuild(client) {
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    const g = client.guilds.cache.get(guildId);
    if (g) return g;
  }
  return client.guilds.cache.first() || null;
}

// JSONB columns arrive as fresh objects on every event, so compare them by content.
function sameValue(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// Coalesce burst updates for the same user (e.g. 8 players completing at
// once when a lineup clears) into a single sync call.
const pendingSyncs = new Map();
function debouncedSync(guild, discordId) {
  if (!discordId) return;
  if (pendingSyncs.has(discordId)) clearTimeout(pendingSyncs.get(discordId));
  const handle = setTimeout(async () => {
    pendingSyncs.delete(discordId);
    try {
      await syncUserRaidRoles(guild, discordId);
    } catch (err) {
      console.error(`[raid-role-realtime] debounced sync failed for ${discordId}:`, err);
    }
  }, DEBOUNCE_MS);
  pendingSyncs.set(discordId, handle);
}

// Handles a single players change for raid-role purposes. Registered on the
// shared players-changes hub (see playersChanges.js) so it no longer opens its
// own channel — that collided with the new-character notifier's binding.
function handlePlayersChange(client, payload) {
  const guild = getPrimaryGuild(client);
  if (!guild) return;

  const oldRow = payload.old || {};
  const newRow = payload.new || {};
  const affected = new Set();

  if (payload.eventType === 'INSERT') {
    if (newRow.discord_id) affected.add(newRow.discord_id);
  } else if (payload.eventType === 'DELETE') {
    if (oldRow.discord_id) affected.add(oldRow.discord_id);
  } else if (payload.eventType === 'UPDATE') {
    let triggered = false;
    for (const col of PLAYER_TRIGGER_COLUMNS) {
      if (!sameValue(oldRow[col], newRow[col])) { triggered = true; break; }
    }
    if (!triggered) return;
    // Owner change → both old and new owner need a re-evaluation.
    if (oldRow.discord_id) affected.add(oldRow.discord_id);
    if (newRow.discord_id) affected.add(newRow.discord_id);
  }

  for (const discordId of affected) debouncedSync(guild, discordId);
}

// app_users changes come through the shared app-users-changes hub (one channel
// for the whole bot) — a second app_users channel here collided with the
// new-user notifier's and dropped to CHANNEL_ERROR. Only exclude toggles matter.
function handleAppUsersChange(client, payload) {
  if (payload.eventType !== 'UPDATE') return;
  const oldRow = payload.old || {};
  const newRow = payload.new || {};
  if (oldRow.exclude === newRow.exclude) return;
  const discordId = newRow.discord_id || oldRow.discord_id;
  if (!discordId) return;

  const guild = getPrimaryGuild(client);
  if (!guild) return;
  debouncedSync(guild, discordId);
}

// Game reset and pg_cron cleanup run Friday 16:00 UTC; last week's game clears stop counting with no row change, so this re-grants roles.
let lastRunDate = null;

async function checkWeeklyGrant(client) {
  const now = new Date();
  if (now.getUTCDay() !== 5) return;
  if (now.getUTCHours() !== 16 || now.getUTCMinutes() < 5) return;
  const dateStr = now.toISOString().slice(0, 10);
  if (lastRunDate === dateStr) return;

  const guild = getPrimaryGuild(client);
  if (!guild) return;

  lastRunDate = dateStr;
  console.log('[raid-role-weekly] starting weekly reconcile');
  try {
    await syncAllUsers(guild);
    console.log('[raid-role-weekly] complete');
  } catch (err) {
    console.error('[raid-role-weekly] failed:', err);
    lastRunDate = null;
  }
}

function startRaidRoleScheduler(client) {
  console.log('[raid-role-scheduler] starting (Realtime + weekly Fri 16:05 UTC)');
  // Players + app_users changes come through shared hubs (one channel each for
  // the whole bot) so overlapping postgres_changes bindings can't collide.
  onPlayersChange((payload) => handlePlayersChange(client, payload));
  startPlayersChanges();
  onAppUsersChange((payload) => handleAppUsersChange(client, payload));
  startAppUsersChanges();
  setInterval(() => {
    checkWeeklyGrant(client).catch(err => {
      console.error('[raid-role-weekly] check failed:', err);
    });
  }, CRON_CHECK_INTERVAL_MS);
}

module.exports = { startRaidRoleScheduler };
