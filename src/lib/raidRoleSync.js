// Dynamic raid-need roles: gives a Discord role to anyone with at least one
// non-excluded character that still needs to clear that raid this week.
// Removes the role once they're out of eligible characters.

const supabase = require('../supabase');
const { isCharacterEligible, ALL_COMPLETION_COLUMNS } = require('./raidTypes');

// raid_type → env var holding the Discord role ID. Missing env var = the
// feature is off for that raid type (no role assigned, no role removed).
const RAID_ROLE_ENV_MAP = {
  'Hardcore': 'RAID_ROLE_GDN_HARDCORE',
  'Classic': 'RAID_ROLE_GDN_CLASSIC',
  'DDN Hardcore': 'RAID_ROLE_DDN_HARDCORE',
  'DDN Classic': 'RAID_ROLE_DDN_CLASSIC',
  'DDN Normal': 'RAID_ROLE_DDN_NORMAL',
};

const PLAYER_SELECT_COLUMNS = [
  'name',
  'discord_id',
  'exclude',
  'classic_ticket_used',
  ...ALL_COMPLETION_COLUMNS,
].join(', ');

function getConfiguredRoles() {
  const map = {};
  for (const [raidType, envVar] of Object.entries(RAID_ROLE_ENV_MAP)) {
    const id = process.env[envVar];
    if (id) map[raidType] = id;
  }
  return map;
}

function getManagedRoleIds() {
  return new Set(Object.values(getConfiguredRoles()));
}

// For a given Discord user, compute which raid types they should currently
// hold a role for. Returns a Set of raid_type strings, or null on DB error.
async function getEligibleRaidTypesForUser(discordId, raidTypes) {
  const { data: appUser, error: appErr } = await supabase
    .from('app_users')
    .select('exclude')
    .eq('discord_id', discordId)
    .maybeSingle();

  if (appErr) {
    console.error(`[raid-role-sync] app_users lookup failed for ${discordId}:`, appErr);
    return null;
  }
  if (appUser?.exclude === true) return new Set();

  const { data: characters, error: charErr } = await supabase
    .from('players')
    .select(PLAYER_SELECT_COLUMNS)
    .eq('discord_id', discordId);

  if (charErr) {
    console.error(`[raid-role-sync] players lookup failed for ${discordId}:`, charErr);
    return null;
  }

  const active = (characters || []).filter(c => c.exclude !== true);
  const eligible = new Set();
  for (const raidType of raidTypes) {
    if (active.some(c => isCharacterEligible(c, raidType))) {
      eligible.add(raidType);
    }
  }
  return eligible;
}

// Reconcile the configured raid-need roles for one user. No-op if no roles
// are configured, if the user isn't in the guild, or if nothing needs to
// change. Only touches roles in RAID_ROLE_ENV_MAP — never strips others.
async function syncUserRaidRoles(guild, discordId) {
  const configuredRoles = getConfiguredRoles();
  const raidTypes = Object.keys(configuredRoles);
  if (raidTypes.length === 0) return { skipped: 'no-roles-configured' };

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { skipped: 'not-in-guild' };

  const targetRaidTypes = await getEligibleRaidTypesForUser(discordId, raidTypes);
  if (targetRaidTypes === null) return { skipped: 'db-error' };

  const targetRoleIds = new Set(
    [...targetRaidTypes].map(rt => configuredRoles[rt]).filter(Boolean)
  );
  const managedRoleIds = new Set(Object.values(configuredRoles));

  const toAdd = [];
  const toRemove = [];
  for (const roleId of managedRoleIds) {
    const has = member.roles.cache.has(roleId);
    const should = targetRoleIds.has(roleId);
    if (should && !has) toAdd.push(roleId);
    if (!should && has) toRemove.push(roleId);
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { added: 0, removed: 0 };
  }

  try {
    if (toAdd.length > 0) await member.roles.add(toAdd, 'Raid role sync: needs clear');
    if (toRemove.length > 0) await member.roles.remove(toRemove, 'Raid role sync: cleared');
    console.log(`[raid-role-sync] ${member.user.tag}: +${toAdd.length} -${toRemove.length}`);
    return { added: toAdd.length, removed: toRemove.length };
  } catch (err) {
    console.error(`[raid-role-sync] role update failed for ${member.user.tag}:`, err);
    return { skipped: 'discord-error', error: err };
  }
}

// Reconcile every registered user. Used by the weekly safety-net cron and
// for manual full re-syncs.
async function syncAllUsers(guild) {
  const { data: users, error } = await supabase
    .from('app_users')
    .select('discord_id');

  if (error) {
    console.error('[raid-role-sync] app_users fetch failed:', error);
    return { total: 0, synced: 0 };
  }

  const total = users.length;
  let synced = 0;
  for (const user of users) {
    if (!user.discord_id) continue;
    try {
      await syncUserRaidRoles(guild, user.discord_id);
      synced++;
    } catch (err) {
      console.error(`[raid-role-sync] sync failed for ${user.discord_id}:`, err);
    }
  }
  console.log(`[raid-role-sync] full sync complete: ${synced}/${total} users`);
  return { total, synced };
}

module.exports = {
  RAID_ROLE_ENV_MAP,
  getConfiguredRoles,
  getManagedRoleIds,
  getEligibleRaidTypesForUser,
  syncUserRaidRoles,
  syncAllUsers,
};
