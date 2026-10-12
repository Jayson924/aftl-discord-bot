// Two-way Discord role ↔ app_users.role sync; both sides compare before writing, so echoes never loop.

const supabase = require('../supabase');
const { onAppUsersChange, startAppUsersChanges } = require('./appUsersChanges');

// Highest first; admin is Discord-only. Resolved by env id, else by name.
const ROLE_MAP = [
  { site: 'admin', env: 'SITE_ROLE_ADMIN_ID', name: 'Vice Members' },
  { site: 'editor', env: 'SITE_ROLE_EDITOR_ID', name: 'Senior Members' },
  { site: 'guildmate', env: 'AFTERLIGHT_ROLE_ID', name: 'Afterlight' },
  { site: 'friend', env: 'SITE_ROLE_FRIEND_ID', name: 'Part-time Afterlight' },
];

// Discord roles to hold when set from the site; editors keep Afterlight too.
const PUSHED_ROLES = {
  editor: ['editor', 'guildmate'],
  guildmate: ['guildmate'],
  friend: ['friend'],
  guest: [],
};

function isOwner(discordId) {
  return !!process.env.OWNER_ID && discordId === process.env.OWNER_ID;
}

function discordRole(guild, siteRole) {
  const entry = ROLE_MAP.find((r) => r.site === siteRole);
  if (!entry) return null;
  const id = process.env[entry.env];
  if (id) return guild.roles.cache.get(id) || null;
  return guild.roles.cache.find((r) => r.name.toLowerCase() === entry.name.toLowerCase()) || null;
}

function siteRoleFor(member) {
  for (const { site } of ROLE_MAP) {
    const role = discordRole(member.guild, site);
    if (role && member.roles.cache.has(role.id)) return site;
  }
  return 'guest';
}

async function setSiteRole(discordId, role) {
  const { data, error } = await supabase
    .from('app_users')
    .update({ role })
    .eq('discord_id', discordId)
    .neq('role', role)
    .select('discord_id');
  if (error) throw error;
  return (data || []).length > 0;
}

// Discord → site for one member (or someone who left: pass `left`).
async function syncMemberToSite(guild, discordId, { member = null, left = false } = {}) {
  if (isOwner(discordId)) return { skipped: 'owner' };
  if (!member && !left) member = await guild.members.fetch(discordId).catch(() => null);
  const role = member ? siteRoleFor(member) : 'guest';
  const changed = await setSiteRole(discordId, role);
  if (changed) console.log(`[site-roles] ${member?.user?.tag || discordId} → ${role} on the web app (from Discord)`);
  return { role, changed };
}

// Site → Discord after the site changed someone's role.
async function pushSiteRoleToDiscord(guild, discordId, siteRole) {
  if (isOwner(discordId)) return { skipped: 'owner' };
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { skipped: 'not-in-server' };

  const current = siteRoleFor(member);
  if (current === siteRole) return { skipped: 'already-matches' };
  // Admin lives in Discord only: put the site back to what Discord says.
  if (current === 'admin' || siteRole === 'admin' || !PUSHED_ROLES[siteRole]) {
    await setSiteRole(discordId, current);
    console.log(`[site-roles] ${member.user.tag}: site role ${siteRole} reverted to ${current} (admin is Discord-only)`);
    return { reverted: current };
  }

  const managed = ['editor', 'guildmate', 'friend'].map((r) => [r, discordRole(guild, r)]);
  const missing = PUSHED_ROLES[siteRole].filter((r) => !managed.find(([s, role]) => s === r && role));
  if (missing.length) {
    console.error(`[site-roles] cannot give ${member.user.tag} ${siteRole}: Discord role for ${missing.join(', ')} not found`);
    return { skipped: 'role-missing' };
  }

  const managedIds = new Set(managed.filter(([, role]) => role).map(([, role]) => role.id));
  const wanted = PUSHED_ROLES[siteRole].map((r) => discordRole(guild, r).id);
  const next = [...member.roles.cache.keys()].filter((id) => id !== guild.id && !managedIds.has(id)).concat(wanted);
  try {
    await member.roles.set(next, `Web app role set to ${siteRole}`);
    console.log(`[site-roles] ${member.user.tag} → ${siteRole} on Discord (from the web app)`);
    return { pushed: siteRole };
  } catch (err) {
    console.error(`[site-roles] could not set Discord roles for ${member.user.tag} (bot role below theirs, or missing Manage Roles?):`, err.message);
    return { skipped: 'discord-error' };
  }
}

// Every site user against Discord. Discord wins. With apply=false it only reports.
async function reconcileAll(guild, { apply = false } = {}) {
  const members = await guild.members.fetch();
  const { data: users, error } = await supabase.from('app_users').select('discord_id, role, display_name, username');
  if (error) throw error;

  const changes = [];
  for (const user of users || []) {
    if (isOwner(user.discord_id)) continue;
    const member = members.get(user.discord_id);
    const role = member ? siteRoleFor(member) : 'guest';
    if (role === (user.role || 'guest')) continue;
    changes.push({ discordId: user.discord_id, name: user.display_name || user.username || user.discord_id, from: user.role || 'guest', to: role, inServer: !!member });
  }
  if (apply) {
    for (const c of changes) await setSiteRole(c.discordId, c.to);
    if (changes.length) console.log(`[site-roles] reconcile applied ${changes.length} change(s)`);
  }
  return { total: (users || []).length, changes };
}

function getPrimaryGuild(client) {
  const id = process.env.GUILD_ID;
  return (id && client.guilds.cache.get(id)) || client.guilds.cache.first() || null;
}

function handleAppUsersChange(client, payload) {
  const guild = getPrimaryGuild(client);
  const row = payload.new || {};
  if (!guild || !row.discord_id) return;

  let work = null;
  // First login: take the role straight from Discord.
  if (payload.eventType === 'INSERT') work = syncMemberToSite(guild, row.discord_id);
  // A role change on the site (app_users has REPLICA IDENTITY FULL, so old.role is there).
  else if (payload.eventType === 'UPDATE' && payload.old?.role !== undefined && payload.old.role !== row.role) {
    work = pushSiteRoleToDiscord(guild, row.discord_id, row.role || 'guest');
  }
  work?.catch((err) => console.error(`[site-roles] sync failed for ${row.discord_id}:`, err));
}

function startSiteRoleSync(client) {
  onAppUsersChange((payload) => handleAppUsersChange(client, payload));
  startAppUsersChanges();

  if (process.env.SITE_ROLE_SYNC_ON_START === 'true') {
    const guild = getPrimaryGuild(client);
    if (guild) {
      reconcileAll(guild, { apply: true }).catch((err) => console.error('[site-roles] startup reconcile failed:', err));
    }
  }
}

module.exports = {
  ROLE_MAP,
  discordRole,
  siteRoleFor,
  syncMemberToSite,
  pushSiteRoleToDiscord,
  reconcileAll,
  startSiteRoleSync,
};
